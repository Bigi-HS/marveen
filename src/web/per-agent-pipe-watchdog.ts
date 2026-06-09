// Per-agent Telegram MCP-pipe watchdog for the SUB-agents (Part 2 of card
// 31ab64fe). Complements two existing layers:
//   - telegram-pipe-watchdog.ts (#27/#36) covers the MAIN orchestrator's own
//     pipe, and survives a dashboard restart.
//   - the dashboard's in-process channel-health-monitor.ts recovers EVERY
//     channel agent (main + sub-agents) -- but only WHILE THE DASHBOARD IS UP,
//     because it runs inside the dashboard process and dies with it.
//
// The gap this closes: the dashboard-DOWN window (deploy/restart/crash/sleep),
// during which no in-process monitor runs and a sub-agent's Telegram MCP child
// can die and stay dead. This sweep therefore acts ONLY when the dashboard is
// DOWN -- if it acted while the dashboard were up it would double-drive the
// /mcp menu against the in-process monitor on the same pane (the 2026-06-01
// churn outage). One owner at a time.
//
// Scope (spike-confirmed, card 31ab64fe): this covers the EXTERNALLY-DETECTABLE
// failure -- the MCP child gone / not polling (409 -> 200, or process absent).
// The wedged-but-alive socketpair case (the `reply` "text.length" symptom) is
// invisible to any external probe and is a separate follow-up (the hook-based
// agent-side detector), NOT this module.
//
// The recovery + decision core is reused verbatim from the orchestrator
// watchdog: the pure verdict/escalation/state functions are imported, and
// recovery is the same tested /mcp-menu navigation (attemptChannelMcpReconnect),
// which is already per-agent. Only the IO is re-pointed per agent (its own bot
// token, its own state file, its own pane).

import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { probeTelegramConflict } from './channel-conflict-probe.js'
import { probeChannelPollerPresence } from './channel-poller-reap.js'
import { attemptChannelMcpReconnect, resolveAgentProviderType } from './channel-mcp-reconnect.js'
import { listAgentNames, agentDir } from './agent-config.js'
import { isAgentRunning, agentHasChannel, isAgentChannelIntentionallyEnabled, isTmuxSessionAlive } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { readAgentHangState, type HangVerdict } from './pipe-hang-detector.js'
import {
  assessPipeLiveness,
  reduceConflictProbes,
  shouldEscalate,
  nextState,
  formatRecoveryEvent,
  sendFallbackAlert,
  INITIAL_STATE,
  type WatchdogState,
  type CycleResult,
  type RecoveryEvent,
} from './telegram-pipe-watchdog.js'

const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()
const DASH_PORT = process.env.DASH_PORT ?? '3420'

// Same probe cadence as the orchestrator watchdog: a few conflict probes ~2s
// apart so the native long-poll's brief inter-cycle gap cannot read as dead.
const CONFLICT_PROBE_RETRIES = 3
const CONFLICT_PROBE_GAP_MS = 2000
const DASHBOARD_HEALTH_TIMEOUT_MS = 3000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Agent names come from the on-disk roster (trusted), but keep the state-file
// path strictly alphanumeric so a malformed name can never escape store/.
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '')
}

function agentStatePath(name: string): string {
  return join(PROJECT_ROOT, 'store', `pipe-watchdog.${safeName(name)}.state.json`)
}

function logPath(): string {
  return join(PROJECT_ROOT, 'store', 'per-agent-pipe-watchdog.log')
}

export function readAgentState(name: string): WatchdogState {
  try {
    const parsed = JSON.parse(readFileSync(agentStatePath(name), 'utf-8')) as Partial<WatchdogState>
    return {
      consecutiveDead: parsed.consecutiveDead ?? 0,
      alerted: parsed.alerted ?? false,
      lastHealthyTs: parsed.lastHealthyTs ?? null,
    }
  } catch {
    return { ...INITIAL_STATE }
  }
}

export function writeAgentState(name: string, state: WatchdogState): void {
  try {
    writeFileSync(agentStatePath(name), JSON.stringify(state), 'utf-8')
  } catch (err) {
    logger.warn({ err, agent: name }, 'per-agent-pipe-watchdog: failed to persist state')
  }
}

function logEvent(name: string, ev: RecoveryEvent): void {
  try {
    appendFileSync(logPath(), `${formatRecoveryEvent(ev)}\tagent=${name}\n`, 'utf-8')
  } catch (err) {
    logger.warn({ err, agent: name }, 'per-agent-pipe-watchdog: failed to append recovery log')
  }
}

// The agent's OWN bot token lives at channelStateDir(provider, agentDir(name))
// -- which composes agents/<name>/.claude/channels/<provider>/.env. NOTE the
// `.claude` (not `.claude-config`): channelStateDir deliberately uses the real
// per-agent channel dir (verified against the in-process monitor's own probe
// path); the agent's `.claude-config/channels` is a symlink to the shared main
// dir and would yield the WRONG (main) token.
function readAgentToken(name: string, provider: ChannelProviderType): string | null {
  try {
    const tokenPath = join(channelStateDir(provider, agentDir(name)), '.env')
    return readChannelToken(provider, tokenPath) || null
  } catch {
    return null
  }
}

// Channel sub-agents to sweep: running + channel intentionally enabled + has a
// token. EXCLUDES the main agent (its own pipe is the orchestrator watchdog's
// job, #27/#36). Mirrors the in-process monitor's isChannelExpectedUp gate so
// the two never disagree on which agents are channel agents.
export function listChannelSubAgents(): string[] {
  return listAgentNames().filter(
    name =>
      name !== MAIN_AGENT_ID &&
      isAgentRunning(name) &&
      agentHasChannel(name) &&
      isAgentChannelIntentionallyEnabled(name),
  )
}

export async function isDashboardUp(): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DASHBOARD_HEALTH_TIMEOUT_MS)
  try {
    // ANY HTTP response (even 401) means the server is up; only a network-level
    // failure (connection refused / abort) means it is down.
    await fetch(`http://127.0.0.1:${DASH_PORT}/api/health`, { signal: controller.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

// One recovery cycle for a single sub-agent. Structurally identical to the
// orchestrator's runCycle (probe -> verdict -> recover/escalate -> persist) but
// every IO is per-agent. Pure decision functions are shared, so the behaviour
// (409 = healthy authority, present===false / steady-200 = dead, anything else
// = inconclusive-and-never-act) is provably the same as the proven path.
export async function runAgentCycle(name: string, now: number = Date.now()): Promise<CycleResult> {
  const prev = readAgentState(name)
  const provider = resolveAgentProviderType(name)
  const token = readAgentToken(name, provider)

  const present = probeChannelPollerPresence(provider, agentDir(name))
  let conflicted = false
  let probeStatus = 0
  if (token) {
    const results: { conflicted: boolean; status: number }[] = []
    for (let i = 0; i < CONFLICT_PROBE_RETRIES; i++) {
      const probe = await probeTelegramConflict(token)
      results.push({ conflicted: probe.conflicted, status: probe.status })
      if (probe.conflicted) break
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
    logEvent(name, { ts: now, kind: 'inconclusive', detail: `present=${present} status=${probeStatus}` })
    const state = nextState(prev, verdict, now)
    writeAgentState(name, state)
    return { verdict, recovered, escalated, state }
  }

  if (verdict === 'healthy') {
    const state = nextState(prev, verdict, now)
    if (prev.consecutiveDead > 0) {
      logEvent(name, { ts: now, kind: 'recovered', detail: `after ${prev.consecutiveDead} dead cycle(s)` })
    }
    writeAgentState(name, state)
    return { verdict, recovered, escalated, state }
  }

  // verdict === 'dead'
  let state = nextState(prev, verdict, now)
  logEvent(name, { ts: now, kind: 'drop-detected', detail: `consecutiveDead=${state.consecutiveDead} present=${present} status=${probeStatus}` })

  logEvent(name, { ts: now, kind: 'recovery-attempt', detail: `attempt for ${name}` })
  const rc = attemptChannelMcpReconnect(name)
  recovered = rc.ok
  logEvent(name, { ts: now, kind: 'recovery-attempt', detail: `result: ${rc.ok ? 'ok' : 'failed'}: ${rc.message}` })

  // Escalate after 2 consecutive dead cycles, once per outage, over the agent's
  // OWN bot token via a direct Bot API call (never the dead pipe).
  if (shouldEscalate(state.consecutiveDead, prev.alerted)) {
    const chatId = process.env.WATCHDOG_ALERT_CHAT_ID ?? ''
    const text =
      `Pipe watchdog (${name}): a Telegram MCP-pipe ${state.consecutiveDead} ciklusa halott ` +
      `(kb ${state.consecutiveDead * 5} perc), a dashboard kozben DOWN. Automatikus /mcp recovery futott ` +
      `(${rc.ok ? 'ok' : 'sikertelen'}). Ha nem all helyre, /mcp az agent-${name} sessionben.`
    let sent = false
    if (token) sent = await sendFallbackAlert(token, chatId, text)
    escalated = sent
    if (sent) {
      state = { ...state, alerted: true }
      logEvent(name, { ts: now, kind: 'escalated', detail: `fallback alert sent to chat ${chatId}` })
    } else {
      logEvent(name, { ts: now, kind: 'escalated', detail: 'fallback alert FAILED (no token/chat or send error)' })
    }
  }

  writeAgentState(name, state)
  return { verdict, recovered, escalated, state }
}

export interface SweepResult {
  // true when the sweep deliberately did nothing because the dashboard is up
  // (the in-process monitor owns recovery then).
  skipped: boolean
  reason: 'dashboard-up' | 'no-channel-agents' | 'swept'
  results: Record<string, CycleResult>
}

// Deps are injectable so the sweep orchestration (skip-when-up, iterate-when-
// down) is unit-testable without real tmux / network / filesystem.
export interface SweepDeps {
  isDashboardUp: () => Promise<boolean>
  listChannelSubAgents: () => string[]
  runAgentCycle: (name: string, now: number) => Promise<CycleResult>
}

const DEFAULT_DEPS: SweepDeps = {
  isDashboardUp,
  listChannelSubAgents,
  runAgentCycle,
}

// Sweep every channel sub-agent, but ONLY when the dashboard is down. When the
// dashboard is up the in-process channel-health-monitor is the single owner of
// per-agent recovery -- acting here too would double-drive the same /mcp pane.
export async function runSubAgentSweep(
  now: number = Date.now(),
  deps: SweepDeps = DEFAULT_DEPS,
): Promise<SweepResult> {
  if (await deps.isDashboardUp()) {
    logger.debug('per-agent-pipe-watchdog: dashboard up -- in-process monitor owns recovery, skipping sweep')
    return { skipped: true, reason: 'dashboard-up', results: {} }
  }

  const agents = deps.listChannelSubAgents()
  if (agents.length === 0) {
    return { skipped: true, reason: 'no-channel-agents', results: {} }
  }

  logger.info({ agents }, 'per-agent-pipe-watchdog: dashboard down -- sweeping sub-agent pipes')
  const results: Record<string, CycleResult> = {}
  for (const name of agents) {
    try {
      results[name] = await deps.runAgentCycle(name, now)
    } catch (err) {
      logger.warn({ err, agent: name }, 'per-agent-pipe-watchdog: agent cycle error')
    }
  }
  return { skipped: false, reason: 'swept', results }
}

// ---------------------------------------------------------------------------
// HANG sweep (card 31ab64fe Part 1): recover a WEDGED socketpair -- the agent
// called a Telegram MCP tool and it HUNG (no tool_result), the symptom no other
// layer sees. UNLIKE the liveness sweep above this runs REGARDLESS of dashboard
// state: a hang is neither a pane-✘ nor a missing poller nor a 409=200, so the
// in-process monitor and the 409 probe both miss it -- there is no overlap to
// double-drive. The recovery is the same tested /mcp navigation.
//
// Scope INCLUDES the main orchestrator (fold-in): the original telegram-pipe
// death symptom is exactly this -- main's own `reply` call wedges and never
// returns. The orchestrator watchdog (#27/#36) and the in-process monitor are
// both liveness/409-based and blind to it, so main's hung call would otherwise
// recover only on a reboot/manual /mcp. The detector reads main's transcript
// (agentConfigRoot -> PROJECT_ROOT) and recovery drives /mcp on the main
// channels session, the exact session attemptChannelMcpReconnect(main) targets.
// ---------------------------------------------------------------------------

// A real Telegram reply returns in well under this; a wedged call never returns.
const HANG_THRESHOLD_MS = 90_000

// Remember the tool_use id we already drove /mcp for, per agent. An abandoned
// hung call STAYS in the transcript (it never gets a result), so without this we
// would re-/mcp the same dead call every tick. We act ONCE per distinct hung
// tool_use; a genuinely new hang (different id) re-arms recovery.
const handledHangId = new Map<string, string>()

export interface HangSweepResult {
  swept: string[]
  recovered: string[]
  results: Record<string, HangVerdict>
}

export interface HangSweepDeps {
  listAgents: () => string[]
  readHangState: (name: string, nowMs: number, thresholdMs: number) => HangVerdict
  reconnect: (name: string) => { ok: boolean; message: string }
  thresholdMs: number
}

// Pure fold-in decision (unit-tested): the hang sweep covers every channel
// sub-agent PLUS the main orchestrator -- but include main only when its
// channels session is actually alive (else /mcp would target a dead session)
// and the operator has not opted out via HANG_SWEEP_EXCLUDE_MAIN. Main is swept
// first so its (higher-stakes) recovery is not starved behind a long sub list.
export function withMainFolded(subAgents: string[], mainAlive: boolean, excludeMain: boolean): string[] {
  const others = subAgents.filter((n) => n !== MAIN_AGENT_ID)
  if (mainAlive && !excludeMain) return [MAIN_AGENT_ID, ...others]
  return others
}

// The agent set the hang sweep walks: sub-agents + the main orchestrator. Kept
// separate from listChannelSubAgents (which the liveness sweep uses and must
// stay main-excluded, since the orchestrator watchdog owns main's liveness).
export function listHangSweepAgents(): string[] {
  return withMainFolded(
    listChannelSubAgents(),
    isTmuxSessionAlive(MAIN_CHANNELS_SESSION),
    process.env.HANG_SWEEP_EXCLUDE_MAIN === '1',
  )
}

const DEFAULT_HANG_DEPS: HangSweepDeps = {
  listAgents: listHangSweepAgents,
  readHangState: readAgentHangState,
  reconnect: attemptChannelMcpReconnect,
  thresholdMs: HANG_THRESHOLD_MS,
}

export function runHangSweep(now: number = Date.now(), deps: HangSweepDeps = DEFAULT_HANG_DEPS): HangSweepResult {
  const swept: string[] = []
  const recovered: string[] = []
  const results: Record<string, HangVerdict> = {}
  for (const name of deps.listAgents()) {
    swept.push(name)
    let verdict: HangVerdict
    try {
      verdict = deps.readHangState(name, now, deps.thresholdMs)
    } catch (err) {
      logger.warn({ err, agent: name }, 'per-agent-pipe-watchdog: hang read error')
      continue
    }
    results[name] = verdict
    if (verdict.state !== 'hung') {
      // Recovered or idle -> forget the handled id so a future hang re-arms.
      if (verdict.state === 'ok' || verdict.state === 'none') handledHangId.delete(name)
      continue
    }
    if (verdict.toolUseId && handledHangId.get(name) === verdict.toolUseId) {
      // Already drove /mcp for THIS hung call; don't re-fire on the abandoned one.
      continue
    }
    logger.warn(
      { agent: name, hungForMs: verdict.hungForMs, toolUseId: verdict.toolUseId },
      'per-agent-pipe-watchdog: HUNG Telegram MCP call -- driving /mcp recovery',
    )
    const rc = deps.reconnect(name)
    if (verdict.toolUseId) handledHangId.set(name, verdict.toolUseId)
    if (rc.ok) recovered.push(name)
    logEvent(name, {
      ts: now,
      kind: rc.ok ? 'recovered' : 'recovery-attempt',
      detail: `hang ${verdict.hungForMs}ms -> /mcp ${rc.ok ? 'ok' : 'failed'}: ${rc.message}`,
    })
  }
  return { swept, recovered, results }
}

// ---------------------------------------------------------------------------
// CLI orchestration (card 31ab64fe Part 1 activation): one watchdog tick runs
// BOTH sweeps -- the liveness sweep (dashboard-down only) and the hang sweep
// (always). Kept here, not in the CLI entry, so it is unit-testable without the
// process.exit / stdout shell. Each sweep is isolated in its own try so one
// failing never suppresses the other or wedges the caller.
// ---------------------------------------------------------------------------

export interface WatchdogSweepDeps {
  subSweep: () => Promise<SweepResult>
  hangSweep: () => HangSweepResult
}

const DEFAULT_WATCHDOG_SWEEP_DEPS: WatchdogSweepDeps = {
  subSweep: () => runSubAgentSweep(),
  hangSweep: () => runHangSweep(),
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Run a full watchdog tick and return the one-line verdicts (the CLI prints
// them). The hang sweep runs regardless of the liveness sweep's outcome.
export async function runWatchdogSweeps(
  deps: WatchdogSweepDeps = DEFAULT_WATCHDOG_SWEEP_DEPS,
): Promise<string[]> {
  const lines: string[] = []

  try {
    const res = await deps.subSweep()
    if (res.skipped) {
      lines.push(`sweep=skipped reason=${res.reason}`)
    } else {
      const parts = Object.entries(res.results).map(
        ([name, r]) => `${name}:${r.verdict}${r.recovered ? '+recovered' : ''}${r.escalated ? '+escalated' : ''}`,
      )
      lines.push(`sweep=done agents=${parts.length} ${parts.join(' ')}`.trimEnd())
    }
  } catch (err) {
    lines.push(`sweep=error detail=${errMsg(err)}`)
  }

  try {
    const h = deps.hangSweep()
    const hung = Object.values(h.results).filter((v) => v.state === 'hung').length
    lines.push(`hang=done swept=${h.swept.length} hung=${hung} recovered=${h.recovered.length}`)
  } catch (err) {
    lines.push(`hang=error detail=${errMsg(err)}`)
  }

  return lines
}
