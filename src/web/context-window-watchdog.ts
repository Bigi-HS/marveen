// Fleet context-window early-warning (card fleet-context-early-warning).
//
// WHY: the TUI statusLine does NOT render in detached/headless agent panes
// (PR #57 c12), so a session ballooning toward its context limit -- the failure
// that froze a 634K-token opus-1M run for ~140 min and ran the shared account
// into a session limit -- is invisible. Nobody watches an agent's tmux footer.
//
// WHAT: each cycle this sweep reads every RUNNING agent's current context usage
// from its latest transcript (the same source as the dashboard's contextTokens),
// turns it into a % of that agent's model window, and fires ONE consolidated
// Telegram alert to the operator when an agent crosses a high-water mark.
//
// Dedup with hysteresis: alert once when an agent crosses ALERT_THRESHOLD; stay
// quiet while it lingers high; re-arm only after it drops back under
// REARM_THRESHOLD. A flapping agent can't spam. Alert state is persisted so the
// dedup survives across the 5-min CLI invocations.
//
// SAFE TO RUN ALWAYS: read-only w.r.t. agents -- it never kills, restarts or
// relaunches anything. It only reads transcripts and sends a direct Bot-API
// message, so (unlike the pipe liveness sweep) it does not self-gate on the
// dashboard being up.

import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { logger } from '../logger.js'
import { channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import {
  listAgentNames,
  agentDir,
  readAgentClaudeConfigDir,
  readAgentModel,
  readAgentDisplayName,
  contextWindowForModel,
  contextPercentForModel,
} from './agent-config.js'
import { readContextTokensFromProjectDir } from './active-model.js'
import { isAgentRunning } from './agent-process.js'
import { sendFallbackAlert } from './telegram-pipe-watchdog.js'

const PROVIDER: ChannelProviderType = 'telegram'

// Fire at/above this %, re-arm only after dropping below the lower line. The gap
// is hysteresis so an agent hovering at the threshold doesn't alert every cycle.
// Boss only wants the Telegram alert when an agent is genuinely near the wall
// (2026-08-13): below this, context is managed by the in-session nudge and the
// auto-compact watcher, not by pinging Dominik.
export const ALERT_THRESHOLD = 98
export const REARM_THRESHOLD = 90

const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()
const STATE_PATH = join(PROJECT_ROOT, 'store', 'context-watchdog-state.json')

export interface ContextUsage {
  percent: number
  tokens: number
  windowSize: number
  model: string | null
}

export interface ContextWatchState {
  alerted: boolean
  lastPercent: number
}

export interface ContextSweepResult {
  swept: string[]
  high: string[] // agents currently at/over ALERT_THRESHOLD
  alerted: string[] // agents newly alerted this cycle
  results: Record<string, number> // agent -> percent (only agents with a reading)
}

export interface ContextSweepDeps {
  listAgents: () => string[]
  readUsage: (name: string) => ContextUsage | null // null = not running / no transcript reading
  sendAlert: (text: string) => Promise<boolean>
  readState: () => Record<string, ContextWatchState>
  writeState: (state: Record<string, ContextWatchState>) => void
  alertThreshold: number
  rearmThreshold: number
}

// ---- default IO implementations ----

function defaultReadUsage(name: string): ContextUsage | null {
  if (!isAgentRunning(name)) return null
  const dir = agentDir(name)
  const configDir = readAgentClaudeConfigDir(name) ?? undefined
  const tokens = readContextTokensFromProjectDir(dir, configDir)
  if (tokens == null) return null
  // The window MUST come from the CONFIGURED model, not the transcript's active
  // model: the transcript reports the base id ("claude-opus-4-8") and DROPS the
  // "[1m]" marker, so a 1M-context Opus would otherwise be sized at the 200K
  // default and false-alert at ~16% real usage (193k/1M read as 97% of 200k).
  // readAgentModel keeps the "[1m]" and is the source of truth for the window.
  const model = readAgentModel(name)
  return {
    tokens,
    model,
    percent: contextPercentForModel(tokens, model),
    windowSize: contextWindowForModel(model),
  }
}

function defaultReadState(): Record<string, ContextWatchState> {
  try {
    if (!existsSync(STATE_PATH)) return {}
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    logger.debug({ err }, 'context-watchdog: state read failed, starting empty')
    return {}
  }
}

function defaultWriteState(state: Record<string, ContextWatchState>): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  } catch (err) {
    logger.debug({ err }, 'context-watchdog: state write failed')
  }
}

// Resolve the MAIN orchestrator's bot token (it always has a channel) so the
// alert reaches the operator even for a channel-less agent that has no token of
// its own. Mirrors telegram-pipe-watchdog's readMainToken.
async function defaultSendAlert(text: string): Promise<boolean> {
  const tokenPath = join(channelStateDir(PROVIDER, undefined), '.env')
  const token = readChannelToken(PROVIDER, tokenPath)
  const chatId = process.env.WATCHDOG_ALERT_CHAT_ID ?? '8643929442'
  if (!token || !chatId) {
    logger.debug('context-watchdog: no main token / chat id -- cannot alert')
    return false
  }
  return sendFallbackAlert(token, chatId, text)
}

const DEFAULT_DEPS: ContextSweepDeps = {
  listAgents: listAgentNames,
  readUsage: defaultReadUsage,
  sendAlert: defaultSendAlert,
  readState: defaultReadState,
  writeState: defaultWriteState,
  alertThreshold: ALERT_THRESHOLD,
  rearmThreshold: REARM_THRESHOLD,
}

function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`
}

export function formatAlert(
  crossed: Array<{ name: string; usage: ContextUsage }>,
  resolveName: (name: string) => string = readAgentDisplayName,
): string {
  const lines = crossed.map(
    ({ name, usage }) =>
      `${resolveName(name)}: ${usage.percent}% (${fmtK(usage.tokens)}/${fmtK(usage.windowSize)}${usage.model ? ', ' + usage.model : ''})`,
  )
  return `⚠️ Kontextus-figyelmeztetes -- agens(ek) a ${ALERT_THRESHOLD}% felett:\n${lines.join('\n')}`
}

// One sweep cycle. Pure control flow over injectable IO so the dedup/hysteresis
// logic is unit-testable without a live fleet.
export async function runContextSweep(
  now: number = Date.now(),
  deps: ContextSweepDeps = DEFAULT_DEPS,
): Promise<ContextSweepResult> {
  void now // reserved for future time-based logic; keeps the signature uniform with the other sweeps
  const state: Record<string, ContextWatchState> = { ...deps.readState() }
  const swept: string[] = []
  const high: string[] = []
  const results: Record<string, number> = {}
  const crossed: Array<{ name: string; usage: ContextUsage }> = []

  for (const name of deps.listAgents()) {
    swept.push(name)
    let usage: ContextUsage | null
    try {
      usage = deps.readUsage(name)
    } catch (err) {
      logger.debug({ err, name }, 'context-watchdog: usage read failed, skipping agent')
      continue
    }
    if (!usage) continue

    results[name] = usage.percent
    const prev = state[name] ?? { alerted: false, lastPercent: 0 }
    const next: ContextWatchState = { alerted: prev.alerted, lastPercent: usage.percent }

    if (usage.percent >= deps.alertThreshold) {
      high.push(name)
      if (!prev.alerted) crossed.push({ name, usage }) // newly over the line -> candidate to alert
    } else if (usage.percent < deps.rearmThreshold && prev.alerted) {
      next.alerted = false // dropped back under the rearm line -> ready to alert again later
    }
    state[name] = next
  }

  // One consolidated alert for everyone who newly crossed. Only mark them
  // alerted if the send SUCCEEDS, so a transient send failure retries next cycle
  // instead of silently swallowing the warning.
  const alerted: string[] = []
  if (crossed.length > 0) {
    let sent = false
    try {
      sent = await deps.sendAlert(formatAlert(crossed))
    } catch (err) {
      logger.debug({ err }, 'context-watchdog: alert send threw')
      sent = false
    }
    if (sent) {
      for (const { name } of crossed) {
        state[name] = { alerted: true, lastPercent: results[name] ?? state[name]?.lastPercent ?? 0 }
        alerted.push(name)
      }
    }
  }

  deps.writeState(state)
  return { swept, high, alerted, results }
}
