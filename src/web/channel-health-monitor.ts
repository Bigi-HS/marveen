import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { listAgentNames, agentDir } from './agent-config.js'
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

const reconnectState = new Map<string, AgentReconnectState>()

function getBackoffMs(attempt: number): number {
  return BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt)
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
export function recoverPipeFromPane(agentName: string, pane: string, psScan: ProcEnvScan): void {
  const now = Date.now()
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
    return
  }

  const attempt = state ? state.attempts : 0
  logger.warn(
    { agentName, attempt, provider: providerType, reason: paneFailing ? 'pane-failed' : 'poller-missing' },
    'channel-health-monitor: plugin failure detected, attempting reconnect',
  )

  const result = attemptChannelMcpReconnect(agentName)

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
