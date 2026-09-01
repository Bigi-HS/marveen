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
 *   - a present child whose probe could NOT reach Telegram (status 0: network
 *     error / abort) is treated as healthy (card 2f0298cf false-blind): we have
 *     positive evidence the process exists and NO death evidence -- a free slot
 *     answers 200 fast, only an unreachable API yields 0. Leaving this
 *     'inconclusive' froze the watchdog: nextState is a no-op on inconclusive,
 *     so consecutiveDead / lastHealthyTs never advanced and auto-recovery was
 *     silently disabled while the pipe was in fact alive. Both hard death
 *     signals (present===false, status===200) are evaluated BEFORE this line,
 *     so a genuinely dead pipe is never masked by it.
 *   - anything else (network error with UNKNOWN presence, present===null) stays
 *     'inconclusive' and must never trigger recovery on the live orchestrator.
 */
export function assessPipeLiveness(facts: PipeLivenessFacts): PipeLiveness {
  if (facts.present === false) return 'dead'
  if (facts.conflicted) return 'healthy'
  if (facts.probeStatus === 200) return 'dead'
  if (facts.present === true && facts.probeStatus === 0) return 'healthy'
  return 'inconclusive'
}

export function needsRecovery(verdict: PipeLiveness): boolean {
  return verdict === 'dead'
}

/**
 * Pure decision: should this cycle stamp the token-free transport-liveness
 * marker (store/.channel-transport-alive, card edc8b7f8)?
 *
 * The marker's contract is "the native bun poller holds the Telegram getUpdates
 * slot => transport alive", and the ONLY proof of that is a 409 conflict. So we
 * stamp iff the verdict is 'healthy' AND it was reached via a real 409:
 *   - 'healthy' + conflicted  -> stamp (409 proven, and present !== false).
 *   - 'healthy' + !conflicted -> do NOT stamp: this is the present===true &&
 *     status===0 false-blind path (process present, Telegram unreachable). We
 *     have process evidence but no slot-ownership proof.
 *   - 'dead' + conflicted     -> do NOT stamp: present===false with a 409 means
 *     the slot is held by the dashboard coordinator polling the SAME token
 *     (card 8b07e17b), NOT our orchestrator child. Stamping would write a
 *     fresh-but-lying marker that suppresses a legitimate channel-watchdog
 *     respawn once the dashboard goes down.
 *   - anything else           -> do NOT stamp.
 */
export function shouldStampTransportAlive(verdict: PipeLiveness, conflicted: boolean): boolean {
  return verdict === 'healthy' && conflicted
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
  // When a real probe last refreshed this state, regardless of verdict. Optional
  // so older persisted state and the orchestrator watchdog (which does not stamp
  // it) stay valid; absence reads as never-checked. Used by the per-agent
  // stale-health backstop (card 35dc7d87) to tell a genuinely-monitored agent
  // from one whose state silently froze.
  lastCheckedTs?: number | null
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

/**
 * Path of the token-free transport-liveness marker (card edc8b7f8). Shares the
 * store dir with the keepalive file so the independent channel-watchdog.sh
 * (STORE=$INSTALL_DIR/store) reads the exact file this loop writes.
 */
export function transportAliveMarkerPath(): string {
  return join(PROJECT_ROOT, 'store', '.channel-transport-alive')
}

/**
 * Advance the transport-liveness marker's mtime. Best-effort: a failed stamp
 * must never crash the watchdog cycle (the marker just ages and the dual-gate
 * falls back to the existing recovery path -- fail toward respawn). Deliberately
 * never touches .channel-keepalive (the TUI-liveness / wedge-detector signal).
 */
export function stampTransportAlive(now: number = Date.now()): void {
  try {
    writeFileSync(transportAliveMarkerPath(), String(Math.floor(now / 1000)), 'utf-8')
  } catch (err) {
    logger.warn({ err }, 'telegram-pipe-watchdog: failed to stamp transport-alive marker')
  }
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
 * Probe the orchestrator pipe's liveness facts: cheap local process presence
 * plus the authoritative Telegram conflict probe, retried across the native
 * long-poll's brief inter-cycle gap (a one-off 200 is not death). Shared by
 * runCycle and the dashboard-boot one-shot recovery so both apply identical
 * liveness logic.
 */
export async function probeOrchestratorPipe(token: string | null): Promise<PipeLivenessFacts> {
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
  return { present, conflicted, probeStatus }
}

/**
 * Run one watchdog cycle. Reads persisted state, probes the orchestrator pipe,
 * acts (recover / escalate), persists the new state, and logs every event.
 * Designed to be invoked once per process by the 5-minute shell driver.
 */
export async function runCycle(now: number = Date.now()): Promise<CycleResult> {
  const prev = readState()
  const token = readMainToken()

  const { present, conflicted, probeStatus } = await probeOrchestratorPipe(token)
  const verdict = assessPipeLiveness({ present, conflicted, probeStatus })
  let recovered = false
  let escalated = false

  // Token-free transport-liveness marker (card edc8b7f8): on a 409-proven
  // healthy verdict, advance store/.channel-transport-alive so the independent
  // channel-watchdog.sh can tell "token-starved idle transport" (skip respawn)
  // from a genuinely dead pipe. Never touches .channel-keepalive.
  if (shouldStampTransportAlive(verdict, conflicted)) {
    stampTransportAlive(now)
  }

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

/**
 * One-shot orchestrator pipe check + immediate recovery, for the dashboard-boot
 * path. The in-process channel-health-monitor's first tick is ~45s out and the
 * standalone watchdog runs on a 5-min cadence, so a dashboard restart that
 * killed the orchestrator's Telegram MCP stdio child leaves Genesis mute for up
 * to those windows (Boss had to run /mcp by hand after the 2026-06-09 deploy).
 *
 * This closes that gap: probe once at boot and, ONLY if the pipe is already
 * dead, drive a single recovery. It is deliberately NARROW:
 *   - it does NOT touch the standalone watchdog's persisted state or its
 *     escalation/alert path (those stay owned by the 5-min loop) -- it is purely
 *     a latency fix, not a second escalation owner;
 *   - it relies on the same #95 liveness logic (assessPipeLiveness: a confirmed-
 *     absent child outranks a coordinator's 409), so a dead pipe is seen as dead
 *     even while another same-token poller holds the slot;
 *   - the wedge-safe idle gate inside attemptChannelMcpReconnect serialises it
 *     against the standalone watchdog, so the two can never double-drive the
 *     pane.
 * Idempotent and safe on a healthy boot (no-op when the pipe is alive). Intended
 * to be fired-and-forgotten (not awaited) from the dashboard boot sequence.
 */
export async function recoverOrchestratorPipeOnce(
  now: number = Date.now(),
): Promise<{ verdict: PipeLiveness; recovered: boolean }> {
  const token = readMainToken()
  const facts = await probeOrchestratorPipe(token)
  const verdict = assessPipeLiveness(facts)
  if (!needsRecovery(verdict)) return { verdict, recovered: false }

  logRecoveryEvent({ ts: now, kind: 'drop-detected', detail: `boot-recovery present=${facts.present} status=${facts.probeStatus}` })
  const rc = attemptChannelMcpReconnect(MAIN_AGENT_ID)
  logRecoveryEvent({ ts: now, kind: 'recovery-attempt', detail: `boot-recovery result: ${rc.ok ? 'ok' : 'failed'}: ${rc.message}` })
  return { verdict, recovered: rc.ok }
}
