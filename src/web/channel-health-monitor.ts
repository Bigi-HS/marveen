import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { createAgentMessage } from '../db.js'
import { listAgentNames, agentDir, readAgentDisplayName } from './agent-config.js'
import { isAgentRunning, capturePane, isAgentChannelIntentionallyEnabled, agentHasChannel } from './agent-process.js'
import {
  attemptChannelMcpReconnect,
  resolveAgentSession,
  resolveAgentProviderType,
} from './channel-mcp-reconnect.js'
import { getProvider } from '../channel-provider.js'
import { captureProcEnvScan, probeChannelPollerPresence, type ProcEnvScan } from './channel-poller-reap.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'

// Detect `plugin:X · ✘ failed` (or ✘ error / ✘ disconnected) in the
// pane output. Claude Code renders this in the MCP status area when a
// channel plugin connection drops.
const PLUGIN_FAILED_RX = /✘\s*(?:failed|error|disconnected)/i

interface AgentReconnectState {
  attempts: number
  lastAttemptAt: number
  nextRetryAt: number
}

const BACKOFF_BASE_MS = 30_000
const BACKOFF_MULTIPLIER = 3
const MAX_RETRIES = 3
const COOLDOWN_MS = 30 * 60 * 1000

// Stuck-busy escalation (card fa3f5012 slice-2). A reconnect that DEFERS (pane
// stayed busy through the idle-catch window) must not burn the MAX_RETRIES
// budget -- that would cool a continuously-busy agent into a 30-min silence and
// its dead pipe would never self-heal. Instead we count CONSECUTIVE deferrals
// and, past the threshold, alert the operator (marveen channel, NOT the Boss
// directly) that the agent is stuck-busy and needs a manual look. Re-alerts no
// more than once per cooldown while still stuck.
const DEFERRAL_ESCALATION_THRESHOLD = 5           // ~5 monitor cycles (~5 min) stuck-busy
const DEFERRAL_ESCALATION_COOLDOWN_MS = 30 * 60 * 1000
// Keep re-attempting the idle-catch every cycle instead of exhausting retries.
const DEFERRAL_RETRY_MS = BACKOFF_BASE_MS

const reconnectState = new Map<string, AgentReconnectState>()

export interface DeferralEscalationState {
  consecutiveDeferrals: number
  lastEscalatedAtMs: number | null
}

const NO_DEFERRAL_STATE: DeferralEscalationState = { consecutiveDeferrals: 0, lastEscalatedAtMs: null }

const deferralState = new Map<string, DeferralEscalationState>()

export interface DeferralEscalationDecision {
  escalate: boolean
  next: DeferralEscalationState
}

/**
 * Pure decision for the stuck-busy operator escalation. A busy-pane deferral
 * that repeats past `threshold` consecutive cycles means the idle-catch never
 * found a window -- the agent is genuinely stuck-busy and the pipe cannot
 * self-heal. Escalate ONCE at threshold, then re-fire no more than once per
 * `cooldownMs` while still stuck. Any non-deferred outcome (recovered, or a real
 * /mcp drive that ran) resets the spell.
 */
export function decideDeferralEscalation(
  input: { deferred: boolean; prev: DeferralEscalationState; nowMs: number },
  t: { threshold: number; cooldownMs: number },
): DeferralEscalationDecision {
  if (!input.deferred) return { escalate: false, next: NO_DEFERRAL_STATE }

  const consecutiveDeferrals = input.prev.consecutiveDeferrals + 1
  const atThreshold = consecutiveDeferrals >= t.threshold
  const cooldownElapsed =
    input.prev.lastEscalatedAtMs == null || input.nowMs - input.prev.lastEscalatedAtMs >= t.cooldownMs
  const fireNow = atThreshold && cooldownElapsed

  return {
    escalate: fireNow,
    next: {
      consecutiveDeferrals,
      lastEscalatedAtMs: fireNow ? input.nowMs : input.prev.lastEscalatedAtMs,
    },
  }
}

function getBackoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt)
}

// Pure Boss-facing body for a stuck-busy escalation. Takes the resolved
// DISPLAY name (card b79a5d3a display-name sweep) so the operator reads
// "Dampier"/"Grace", not the raw routing id. Exported for unit testing.
export function stuckBusyAlertContent(displayName: string, consecutiveDeferrals: number): string {
  return (
    `⚠️ Csatorna-recovery: a(z) ${displayName} Telegram MCP-pipe-ja ${consecutiveDeferrals} egymas utani cikluson at ` +
    `(~${consecutiveDeferrals} perc) halott, de a pane vegig busy volt -> az idle-catch nem talalt ablakot a ` +
    `/mcp-hez, magatol nem gyogyul. Nezd meg a sessiont (input-buffer tiszta-e), es kezi /mcp reconnect kell. ` +
    `A szerver-oldali POST /api/notify/telegram fallback addig is kezbesit a valaszaihoz.`
  )
}

// Operator alert for a stuck-busy agent: routed to the orchestrator (marveen)
// as an inter-agent message, NOT a direct Boss DM -- marveen decides whether/how
// to relay (card fa3f5012 slice-2 decision). Best-effort: a DB hiccup must never
// throw out of the monitor sweep.
function escalateStuckBusy(agentName: string, consecutiveDeferrals: number): void {
  const content = stuckBusyAlertContent(readAgentDisplayName(agentName), consecutiveDeferrals)
  try {
    createAgentMessage('channel-health-monitor', MAIN_AGENT_ID, content, false, 'high')
    logger.error(
      { agentName, consecutiveDeferrals },
      'channel-health-monitor: agent stuck-busy through idle-catch -- escalated to operator',
    )
  } catch (err) {
    logger.warn({ err, agentName }, 'channel-health-monitor: stuck-busy operator escalation failed')
  }
}

function isPluginFailedInPane(pane: string, pluginPaneId: string): boolean {
  if (!pane.includes(pluginPaneId)) return false
  return PLUGIN_FAILED_RX.test(pane)
}

// Complementary failure signal to the pane ✘-marker: an MCP poller killed
// EXTERNALLY (dashboard deploy-restart / OS-sleep) leaves a dead pipe that
// Claude Code does not render as ✘, so isPluginFailedInPane misses it. We then
// fall back to probing whether the poller process actually exists.
//
// Pure so it is unit-testable: reconnect ONLY when the channel is supposed to be
// up AND the probe is CERTAIN the poller is absent (false). `null` means the
// probe could not determine presence -> fail-safe, never act (no false reconnect
// on the live orchestrator).
export function shouldReconnectOnMissingPoller(facts: {
  expectedUp: boolean
  pollerPresent: boolean | null
}): boolean {
  return facts.expectedUp && facts.pollerPresent === false
}

// Is this agent's channel SUPPOSED to be up (so a missing poller is a fault, not
// the normal channel-less state)? The main agent's channel is always expected;
// a sub-agent's only when its plugin is intentionally enabled AND it has a token.
function isChannelExpectedUp(agentName: string): boolean {
  if (agentName === MAIN_AGENT_ID) return true
  return isAgentChannelIntentionallyEnabled(agentName) && agentHasChannel(agentName)
}

// Where the agent's channel state lives: undefined (=> ~/.claude/channels) for
// the main agent, the agent dir for a sub-agent.
function probeDirForAgent(agentName: string): string | undefined {
  return agentName === MAIN_AGENT_ID ? undefined : agentDir(agentName)
}

export interface ChannelHealthStatus {
  healthy: boolean
  reconnectAttempts: number
  lastAttemptAt: number | null
}

export function getChannelHealth(agentName: string): ChannelHealthStatus {
  const state = reconnectState.get(agentName)
  if (!state) return { healthy: true, reconnectAttempts: 0, lastAttemptAt: null }
  return {
    healthy: false,
    reconnectAttempts: state.attempts,
    lastAttemptAt: state.lastAttemptAt,
  }
}

function checkAgent(agentName: string, session: string, psScan: ProcEnvScan): void {
  const pane = capturePane(session)
  if (!pane) return
  recoverPipeFromPane(agentName, pane, psScan)
}

// Shared pipe-recovery core, given an ALREADY-captured pane. Called by the 60s
// health monitor (checkAgent) and by the busy->idle idle-trigger (card 667281e4)
// so both share ONE backoff/anti-flap state (reconnectState) -- the idle path
// must not hammer reconnect on rapid busy/idle flapping. Backoff-gated: a recent
// attempt or an exhausted-retry cooldown short-circuits before any tmux/ps work.
export function recoverPipeFromPane(agentName: string, pane: string, psScan: ProcEnvScan, now: number = Date.now()): void {
  const state = reconnectState.get(agentName)

  if (state && state.attempts >= MAX_RETRIES) {
    if (now - state.lastAttemptAt > COOLDOWN_MS) {
      reconnectState.delete(agentName)
    }
    return
  }

  if (state && now < state.nextRetryAt) return

  const providerType = resolveAgentProviderType(agentName)
  const provider = getProvider(providerType)

  const paneFailing = isPluginFailedInPane(pane, provider.pluginPaneId)

  // When the pane shows no ✘, also probe whether the poller process is actually
  // alive -- an externally-killed MCP child (deploy-restart / OS-sleep) the pane
  // never flags. Only probe when the channel is expected up, and only treat a
  // CERTAIN absence (false) as a fault; null (probe inconclusive) is ignored.
  let missingPoller = false
  if (!paneFailing && isChannelExpectedUp(agentName)) {
    const present = probeChannelPollerPresence(providerType, probeDirForAgent(agentName), psScan)
    missingPoller = shouldReconnectOnMissingPoller({ expectedUp: true, pollerPresent: present })
  }

  if (!paneFailing && !missingPoller) {
    if (state) {
      logger.info({ agentName, provider: providerType }, 'channel-health-monitor: plugin recovered')
      reconnectState.delete(agentName)
    }
    deferralState.delete(agentName)
    return
  }

  const attempt = state ? state.attempts : 0
  logger.warn(
    { agentName, attempt, provider: providerType, reason: paneFailing ? 'pane-failed' : 'poller-missing' },
    'channel-health-monitor: plugin failure detected, attempting reconnect',
  )

  const result = attemptChannelMcpReconnect(agentName)

  if (result.deferred) {
    // The pane stayed busy through the whole idle-catch window: /mcp never ran,
    // so this is NOT a spent reconnect attempt. Do NOT advance the MAX_RETRIES
    // budget (which would silence the agent for 30 min); keep retrying the
    // idle-catch next cycle, and escalate to the operator once the agent has
    // been stuck-busy past the threshold (card fa3f5012 slice-2).
    reconnectState.set(agentName, {
      attempts: attempt,
      lastAttemptAt: now,
      nextRetryAt: now + DEFERRAL_RETRY_MS,
    })

    const decision = decideDeferralEscalation(
      { deferred: true, prev: deferralState.get(agentName) ?? NO_DEFERRAL_STATE, nowMs: now },
      { threshold: DEFERRAL_ESCALATION_THRESHOLD, cooldownMs: DEFERRAL_ESCALATION_COOLDOWN_MS },
    )
    deferralState.set(agentName, decision.next)
    if (decision.escalate) escalateStuckBusy(agentName, decision.next.consecutiveDeferrals)

    logger.warn(
      { agentName, attempt, consecutiveDeferrals: decision.next.consecutiveDeferrals },
      'channel-health-monitor: reconnect deferred (pane busy) -- idle-catch will retry next cycle',
    )
    return
  }

  // A real /mcp drive ran (succeeded or genuinely failed): the stuck-busy spell,
  // if any, is over.
  deferralState.delete(agentName)

  const backoffMs = getBackoffMs(attempt)
  reconnectState.set(agentName, {
    attempts: attempt + 1,
    lastAttemptAt: now,
    nextRetryAt: now + backoffMs,
  })

  if (result.ok) {
    logger.info({ agentName, attempt }, 'channel-health-monitor: reconnect succeeded')
  } else {
    logger.warn(
      { agentName, attempt, message: result.message },
      'channel-health-monitor: reconnect failed',
    )
  }
}

export function startChannelHealthMonitor(): NodeJS.Timeout {
  function check() {
    // One `ps eww -e` per tick, shared across every agent's poller probe (P9-F2)
    // instead of forking `ps` per channel-enabled agent.
    const psScan = captureProcEnvScan()

    try {
      checkAgent(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION, psScan)
    } catch (err) {
      logger.debug({ err }, 'channel-health-monitor: main agent check error')
    }

    for (const name of listAgentNames()) {
      if (!isAgentRunning(name)) continue
      try {
        checkAgent(name, resolveAgentSession(name), psScan)
      } catch (err) {
        logger.debug({ err, agent: name }, 'channel-health-monitor: agent check error')
      }
    }
  }

  // Offset from channel-monitor's 30s initial delay to avoid
  // overlapping tmux interactions on the same tick.
  setTimeout(check, 45_000)
  return setInterval(check, 60_000)
}
