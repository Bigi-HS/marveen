// Standalone Telegram MCP-pipe watchdog for the MAIN orchestrator session.
//
// The failure it closes (the "Genesis elnemulas"): the orchestrator
// (marveen-channels) runs the native Telegram plugin as a `bun` MCP stdio
// child. A long OS sleep OR a dashboard-server restart kills that child and it
// does NOT respawn -- the `reply` tool vanishes and Genesis goes mute on
// Telegram until a human runs `/mcp` by hand. The in-process channel-health-
// monitor recovers the dashboard's OWN poller, but NOT this orchestrator child,
// and it dies together with the dashboard on a restart.
//
// This watchdog is therefore a SEPARATE 5-minute process (driven by
// scripts/telegram-pipe-watchdog.sh) that survives a dashboard restart. Each
// cycle it:
//   1. Probes whether the orchestrator's Telegram pipe is alive AND polling.
//   2. On a confirmed-dead pipe, drives recovery via the existing, tested
//      /mcp-menu navigation (attemptChannelMcpReconnect).
//   3. After 2 consecutive dead cycles (~10 min) it escalates with ONE
//      fallback Telegram alert sent over a DIRECT Bot API call (never the dead
//      pipe), then stays quiet until the pipe recovers (anti-spam).
//   4. Appends a timestamped recovery-event line to a log so the behaviour is
//      provable after the fact.
//
// Liveness signal: the authoritative one is the Telegram 409 Conflict. A
// getUpdates probe issued by the watchdog returns 409 when the native poller
// holds the token's getUpdates slot (= healthy, actively polling), and a clean
// 200 when the slot is FREE (= nobody is polling = dead pipe). A network error
// is inconclusive and never triggers action (fail-safe). Process presence
// (bot.pid + ps env-scan) is a secondary signal that catches the "child gone"
// case before we even probe.
//
// Pure decision functions are exported and unit-tested; IO lives in runCycle().

import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { probeTelegramConflict } from './channel-conflict-probe.js'
import { probeChannelPollerPresence } from './channel-poller-reap.js'
import { attemptChannelMcpReconnect } from './channel-mcp-reconnect.js'

export type PipeLiveness = 'healthy' | 'dead' | 'inconclusive'

export interface PipeLivenessFacts {
  // probeChannelPollerPresence result: true present / false absent / null unknown.
  present: boolean | null
  // probeTelegramConflict: a 409 proves the native poller holds the slot.
  conflicted: boolean
  // HTTP status of the conflict probe: 409 healthy, 200 slot-free (dead), 0 network-error.
  probeStatus: number
}

/**
 * Pure liveness verdict. Authority order:
 *   - a process that is CERTAINLY gone (present === false) is dead -- this is
 *     the DIRECT signal and it OUTRANKS a 409. A 409 only proves that *some*
 *     poller holds the token's getUpdates slot, NOT that the orchestrator's own
 *     plugin child specifically is alive: the dashboard coordinator polls the
 *     same token and its 409 would otherwise mask a confirmed-dead orchestrator
 *     child (card 8b07e17b -- "409 inference is perturbable by a same-token
 *     coordinator poll"). Process absence cannot be perturbed that way.
 *   - a 409 with the child still present (or presence unknown) is proof the
 *     native poller is alive and actively polling.
 *   - a clean 200 from the probe means the getUpdates slot was free while we
 *     expected a poller -> the pipe is dead (the child may linger but is not
 *     polling) -- the DIRECT slot-free death signal, not a 409 inference.
 *   - anything else (network error, inconclusive presence) is 'inconclusive'
 *     and must never trigger recovery on the live orchestrator.
 */
export function assessPipeLiveness(facts: PipeLivenessFacts): PipeLiveness {
  if (facts.present === false) return 'dead'
  if (facts.conflicted) return 'healthy'
  if (facts.probeStatus === 200) return 'dead'
  return 'inconclusive'
}

export function needsRecovery(verdict: PipeLiveness): boolean {
  return verdict === 'dead'
}

/**
 * Aggregate several conflict probes issued within one cycle into a single
 * verdict, tolerant of the native long-poll's brief inter-cycle gap.
 *
 * The native Telegram poller issues a long getUpdates (30-50s), processes, then
 * issues the next one; between cycles there is a sub-second-to-seconds gap. A
 * single timeout=0 probe that lands in that gap returns a clean 200 even though
 * the poller is perfectly healthy. So a ONE-OFF 200 must NOT be read as death.
 *
 * Rule:
 *   - ANY 409 across the probes -> alive (the slot was held at least once;
 *     a wedged/dead pipe never produces a 409).
 *   - EVERY probe a clean 200 -> the slot was reliably free across the whole
 *     window -> not polling (dead/wedged). A healthy long-poll spanning ~30s
 *     cannot be absent from several probes a few seconds apart.
 *   - anything else (network errors, mixed non-200) -> inconclusive (status 0).
 */
export function reduceConflictProbes(
  results: ReadonlyArray<{ conflicted: boolean; status: number }>,
): { conflicted: boolean; status: number } {
  if (results.length === 0) return { conflicted: false, status: 0 }
  if (results.some(r => r.conflicted)) return { conflicted: true, status: 409 }
  if (results.every(r => r.status === 200)) return { conflicted: false, status: 200 }
  return { conflicted: false, status: 0 }
}

/**
 * Escalate only after the pipe has been dead for `threshold` consecutive
 * cycles (default 2 = ~10 min at a 5-min cadence) AND we have not already
 * alerted for this outage. The anti-spam invariant: one alert per outage, no
 * matter how long it lasts; the alerted flag is cleared when the pipe recovers.
 */
export function shouldEscalate(
  consecutiveDeadCycles: number,
  alreadyAlerted: boolean,
  threshold = 2,
): boolean {
  return consecutiveDeadCycles >= threshold && !alreadyAlerted
}

export interface WatchdogState {
  consecutiveDead: number
  alerted: boolean
  lastHealthyTs: number | null
}

export const INITIAL_STATE: WatchdogState = {
  consecutiveDead: 0,
  alerted: false,
  lastHealthyTs: null,
}

/**
 * Pure state transition for one observed verdict.
 *   - healthy     -> reset counters, clear the alert, stamp lastHealthyTs.
 *   - dead        -> increment the consecutive-dead counter (alert flag is set
 *                    separately by the cycle when it actually sends the alert).
 *   - inconclusive-> leave the state untouched (fail-safe: never escalate or
 *                    reset on a probe we could not trust).
 */
export function nextState(
  prev: WatchdogState,
  verdict: PipeLiveness,
  now: number,
): WatchdogState {
  if (verdict === 'healthy') {
    return { consecutiveDead: 0, alerted: false, lastHealthyTs: now }
  }
  if (verdict === 'dead') {
    return { ...prev, consecutiveDead: prev.consecutiveDead + 1 }
  }
  return prev
}

export type RecoveryEventKind =
  | 'drop-detected'
  | 'recovery-attempt'
  | 'recovered'
  | 'escalated'
  | 'inconclusive'

export interface RecoveryEvent {
  ts: number
  kind: RecoveryEventKind
  detail: string
}

/** Pure log-line formatter so the recovery log is asserted in tests. */
export function formatRecoveryEvent(ev: RecoveryEvent): string {
  const iso = new Date(ev.ts).toISOString()
  return `${iso}\t${ev.kind}\t${ev.detail}`
}

// ---------------------------------------------------------------------------
// IO: state file, recovery-event log, fallback alert, and the cycle itself.
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()
const PROVIDER: ChannelProviderType = 'telegram'

// Conflict-probe retries within one cycle, to ride over the native poller's
// inter-cycle gap (see reduceConflictProbes). A healthy long-poll spans ~30s,
// so 3 probes ~2s apart will catch it in-flight at least once.
const CONFLICT_PROBE_RETRIES = 3
const CONFLICT_PROBE_GAP_MS = 2000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function statePath(): string {
  return join(PROJECT_ROOT, 'store', 'telegram-pipe-watchdog.state.json')
}

function logPath(): string {
  return join(PROJECT_ROOT, 'store', 'telegram-pipe-watchdog.log')
}

export function readState(): WatchdogState {
  try {
    const raw = readFileSync(statePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<WatchdogState>
    return {
      consecutiveDead: parsed.consecutiveDead ?? 0,
      alerted: parsed.alerted ?? false,
      lastHealthyTs: parsed.lastHealthyTs ?? null,
    }
  } catch {
    return { ...INITIAL_STATE }
  }
}

export function writeState(state: WatchdogState): void {
  try {
    writeFileSync(statePath(), JSON.stringify(state), 'utf-8')
  } catch (err) {
    logger.warn({ err }, 'telegram-pipe-watchdog: failed to persist state')
  }
}

export function logRecoveryEvent(ev: RecoveryEvent): void {
  try {
    appendFileSync(logPath(), formatRecoveryEvent(ev) + '\n', 'utf-8')
  } catch (err) {
    logger.warn({ err }, 'telegram-pipe-watchdog: failed to append recovery log')
  }
}

function readMainToken(): string | null {
  try {
    // The MAIN orchestrator's channel state lives under the HOME .claude dir
    // (channelStateDir with no agentDir), matching probeChannelPollerPresence's
    // `undefined` dir for the main agent. This is NOT the project root.
    const tokenPath = join(channelStateDir(PROVIDER, undefined), '.env')
    const tok = readChannelToken(PROVIDER, tokenPath)
    return tok || null
  } catch {
    return null
  }
}

/**
 * Send a SINGLE fallback alert via a direct Bot API sendMessage call. This
 * deliberately bypasses the (dead) MCP pipe -- it is a plain HTTPS POST, so it
 * works even when the orchestrator's plugin child is gone. chat_id is the
 * operator's own chat; the token is the main bot's.
 */
export async function sendFallbackAlert(token: string, chatId: string, text: string): Promise<boolean> {
  if (!token || !chatId) return false
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
    })
    return res.ok
  } catch (err) {
    logger.warn({ err }, 'telegram-pipe-watchdog: fallback alert failed')
    return false
  } finally {
    clearTimeout(timeout)
  }
}

export interface CycleResult {
  verdict: PipeLiveness
  recovered: boolean
  escalated: boolean
  state: WatchdogState
}

/**
 * Run one watchdog cycle. Reads persisted state, probes the orchestrator pipe,
 * acts (recover / escalate), persists the new state, and logs every event.
 * Designed to be invoked once per process by the 5-minute shell driver.
 */
export async function runCycle(now: number = Date.now()): Promise<CycleResult> {
  const prev = readState()
  const token = readMainToken()

  // Probe presence (cheap, local) + conflict (authoritative liveness). Probe
  // the conflict several times so the native long-poll's brief inter-cycle gap
  // cannot masquerade as a dead pipe (a one-off 200 is not death).
  const present = probeChannelPollerPresence(PROVIDER, undefined)
  let conflicted = false
  let probeStatus = 0
  if (token) {
    const results: { conflicted: boolean; status: number }[] = []
    for (let i = 0; i < CONFLICT_PROBE_RETRIES; i++) {
      const probe = await probeTelegramConflict(token)
      results.push({ conflicted: probe.conflicted, status: probe.status })
      if (probe.conflicted) break // a 409 is conclusive (alive) -- stop early
      if (i < CONFLICT_PROBE_RETRIES - 1) await sleep(CONFLICT_PROBE_GAP_MS)
    }
    const agg = reduceConflictProbes(results)
    conflicted = agg.conflicted
    probeStatus = agg.status
  }

  const verdict = assessPipeLiveness({ present, conflicted, probeStatus })
  let recovered = false
  let escalated = false

  if (verdict === 'inconclusive') {
    logRecoveryEvent({ ts: now, kind: 'inconclusive', detail: `present=${present} status=${probeStatus}` })
    const state = nextState(prev, verdict, now)
    writeState(state)
    return { verdict, recovered, escalated, state }
  }

  if (verdict === 'healthy') {
    const state = nextState(prev, verdict, now)
    // Only log a recovery transition (dead -> healthy), not every healthy tick.
    if (prev.consecutiveDead > 0) {
      logRecoveryEvent({ ts: now, kind: 'recovered', detail: `after ${prev.consecutiveDead} dead cycle(s)` })
    }
    writeState(state)
    return { verdict, recovered, escalated, state }
  }

  // verdict === 'dead'
  let state = nextState(prev, verdict, now)
  logRecoveryEvent({ ts: now, kind: 'drop-detected', detail: `consecutiveDead=${state.consecutiveDead} present=${present} status=${probeStatus}` })

  // Drive recovery via the tested /mcp-menu navigation (handles failed/disabled
  // states, never presses Disable).
  logRecoveryEvent({ ts: now, kind: 'recovery-attempt', detail: `attempt for ${MAIN_AGENT_ID}` })
  const rc = attemptChannelMcpReconnect(MAIN_AGENT_ID)
  recovered = rc.ok
  logRecoveryEvent({ ts: now, kind: 'recovery-attempt', detail: `result: ${rc.ok ? 'ok' : 'failed'}: ${rc.message}` })

  // Escalate after 2 consecutive dead cycles, once per outage, over the
  // fallback (direct Bot API) path -- never the dead pipe.
  if (shouldEscalate(state.consecutiveDead, prev.alerted)) {
    const chatId = process.env.WATCHDOG_ALERT_CHAT_ID ?? ''
    const text =
      `Telegram pipe watchdog: az orchestrator MCP-pipe ${state.consecutiveDead} ciklusa halott ` +
      `(kb ${state.consecutiveDead * 5} perc). Automatikus /mcp recovery futott (${rc.ok ? 'ok' : 'sikertelen'}). ` +
      `Ha ez nem all helyre, futtass /mcp-t a marveen-channels sessionben.`
    let sent = false
    if (token) sent = await sendFallbackAlert(token, chatId, text)
    escalated = sent
    if (sent) {
      state = { ...state, alerted: true }
      logRecoveryEvent({ ts: now, kind: 'escalated', detail: `fallback alert sent to chat ${chatId}` })
    } else {
      logRecoveryEvent({ ts: now, kind: 'escalated', detail: 'fallback alert FAILED (no token/chat or send error)' })
    }
  }

  writeState(state)
  return { verdict, recovered, escalated, state }
}
