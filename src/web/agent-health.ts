/**
 * Fleet health observability: a single per-agent record combining the signals
 * that tell an operator whether each agent is alive and making progress.
 *
 * Triple purpose (fleet-meeting #1 innovation, kanban d1b50fdb):
 *  - visible failures: surface stalled / stopped agents at a glance,
 *  - measurement substrate for model right-sizing / optimization (token rollup),
 *  - the same last-progress vs last-inbound signal the main-session stall
 *    watchdog keys off, exposed per-agent.
 *
 * The classification is a pure function (classifyAgentHealth / buildAgentHealth)
 * so it is unit-testable without any tmux / filesystem IO. gatherAgentHealth and
 * collectFleetHealth are the thin IO wrappers that read the live facts.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { MAIN_AGENT_ID, CHANNEL_PROVIDER, PROJECT_ROOT } from '../config.js'
import { listAgentNames, agentDir, readAgentChannelProviderSafe, readAgentClaudeConfigDir } from './agent-config.js'
import {
  isAgentRunning,
  agentSessionName,
  capturePane,
  agentHasChannel,
  isAgentChannelIntentionallyEnabled,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { projectsDirFor, readLastTurnTsFromProjectDir, readContextTokensFromProjectDir } from './active-model.js'
import { readLastIngestionTimestamp } from './inbound-probe.js'
import { getTokenSummary, type TokenSummary } from './token-usage.js'

const TMUX = resolveFromPath('tmux')

// An agent counts as "active" when it produced a turn within this window, and
// "stalled" when an inbound message is newer than its last turn by more than
// the stall window (mirrors STALL_THRESHOLD_MS in channel-monitor.ts: the
// agent ingested input but has not advanced). Both are deliberately generous so
// the dashboard does not flap a healthy-but-quiet agent into a warning state.
export const HEALTH_ACTIVE_MS = 5 * 60 * 1000
export const HEALTH_STALL_MS = 10 * 60 * 1000

export type AgentHealthStatus = 'stopped' | 'idle' | 'active' | 'stalled'

export interface AgentChannelState {
  provider: string | null
  intentionallyEnabled: boolean
  hasToken: boolean
  /** True when the channel-provider config is unreadable (e.g. a misconfigured
   *  secret pointer). Surfaced in the health view so a bad config is visible;
   *  the launch path fails soft (default provider) rather than crashing. */
  misconfigured?: boolean
}

export interface AgentTokenRollup {
  totalCalls: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
}

export interface AgentHealthFacts {
  name: string
  isMain: boolean
  alive: boolean
  /** Last assistant turn (ms epoch) -- when the agent last produced output. */
  lastProgressTs: number | null
  /** Last inbound channel ingestion (ms epoch). */
  lastInboundTs: number | null
  /** tmux session_created (ms epoch) -- the current process's start = last (re)start. */
  lastRestartTs: number | null
  /** Live context size in tokens of the running session, or null. */
  contextTokens: number | null
  channel: AgentChannelState
  /** Cumulative token usage rolled up from the transcript, or null if none. */
  tokenUsage: AgentTokenRollup | null
}

export interface AgentHealth extends AgentHealthFacts {
  status: AgentHealthStatus
  lastProgressAgeMs: number | null
  lastInboundAgeMs: number | null
}

/**
 * Pure health verdict from the raw facts. Order of checks matters:
 *  - a dead session is always 'stopped' (nothing else is meaningful),
 *  - an inbound newer than the last turn by more than the stall window is
 *    'stalled' (ingested but not advancing),
 *  - a recent turn is 'active',
 *  - everything else (alive, quiet) is 'idle'.
 */
export function classifyAgentHealth(facts: AgentHealthFacts, nowMs: number): AgentHealthStatus {
  if (!facts.alive) return 'stopped'

  const { lastProgressTs, lastInboundTs } = facts
  const inboundIsNewer =
    lastInboundTs != null && (lastProgressTs == null || lastInboundTs > lastProgressTs)
  if (inboundIsNewer && nowMs - (lastInboundTs as number) > HEALTH_STALL_MS) {
    return 'stalled'
  }

  if (lastProgressTs != null && nowMs - lastProgressTs < HEALTH_ACTIVE_MS) {
    return 'active'
  }
  return 'idle'
}

export function buildAgentHealth(facts: AgentHealthFacts, nowMs: number): AgentHealth {
  return {
    ...facts,
    status: classifyAgentHealth(facts, nowMs),
    lastProgressAgeMs: facts.lastProgressTs == null ? null : nowMs - facts.lastProgressTs,
    lastInboundAgeMs: facts.lastInboundTs == null ? null : nowMs - facts.lastInboundTs,
  }
}

function sessionCreatedMs(session: string): number | null {
  try {
    const out = execFileSync(
      TMUX,
      ['display-message', '-p', '-t', `=${session}:`, '#{session_created}'],
      { timeout: 3000, encoding: 'utf-8' },
    ).trim()
    const secs = parseInt(out, 10)
    return Number.isFinite(secs) ? secs * 1000 : null
  } catch {
    return null
  }
}

function rollupFromSummary(s: TokenSummary | undefined): AgentTokenRollup | null {
  if (!s) return null
  return {
    totalCalls: s.totalCalls,
    totalInput: s.totalInput,
    totalOutput: s.totalOutput,
    totalCacheRead: s.totalCacheRead,
    totalCacheCreation: s.totalCacheCreation,
  }
}

// Channel state for the main orchestrator differs from sub-agents: it does not
// have an agent-config.json and lives at PROJECT_ROOT, not under agents/. It
// always runs a channel (the operator's own bot), so we report the host default
// provider as intentionally enabled rather than probing a sub-agent-shaped tree.
function mainChannelState(): AgentChannelState {
  return { provider: CHANNEL_PROVIDER, intentionallyEnabled: true, hasToken: true }
}

export function subAgentChannelState(name: string): AgentChannelState {
  // Fail-soft: a misconfigured secret pointer surfaces as a health flag instead
  // of crashing the health collector. intentionallyEnabled / agentHasChannel
  // route through the hardened resolveAgentProvider, so they are throw-safe too.
  const read = readAgentChannelProviderSafe(name)
  const configured = read.provider
  return {
    provider: configured && configured.trim() ? configured : CHANNEL_PROVIDER,
    intentionallyEnabled: isAgentChannelIntentionallyEnabled(name),
    hasToken: agentHasChannel(name),
    misconfigured: read.misconfigured,
  }
}

/**
 * Read the live facts for one agent and classify. `summariesByAgent` is the
 * token-usage rollup indexed by agent id (pass it in so collectFleetHealth
 * queries the DB once for the whole fleet rather than once per agent).
 */
export function gatherAgentHealth(
  name: string,
  opts: { isMain?: boolean; summariesByAgent?: Map<string, TokenSummary> } = {},
  nowMs: number = Date.now(),
): AgentHealth {
  const isMain = opts.isMain ?? false
  const summary = opts.summariesByAgent?.get(name)

  let alive: boolean
  let workingDir: string
  let configDir: string | undefined
  let session: string
  let channel: AgentChannelState

  if (isMain) {
    session = MAIN_CHANNELS_SESSION
    alive = capturePane(session) !== null
    workingDir = PROJECT_ROOT
    configDir = undefined
    channel = mainChannelState()
  } else {
    session = agentSessionName(name)
    alive = isAgentRunning(name)
    workingDir = agentDir(name)
    configDir = readAgentClaudeConfigDir(name) ?? undefined
    channel = subAgentChannelState(name)
  }

  const transcriptDir = projectsDirFor(workingDir, configDir)

  const facts: AgentHealthFacts = {
    name,
    isMain,
    alive,
    lastProgressTs: readLastTurnTsFromProjectDir(workingDir, configDir),
    lastInboundTs: readLastIngestionTimestamp(transcriptDir),
    lastRestartTs: alive ? sessionCreatedMs(session) : null,
    contextTokens: alive ? readContextTokensFromProjectDir(workingDir, configDir) : null,
    channel,
    tokenUsage: rollupFromSummary(summary),
  }

  return buildAgentHealth(facts, nowMs)
}

/**
 * Health record for every agent in the fleet, main orchestrator first. One
 * token-usage DB query is shared across all agents.
 */
export function collectFleetHealth(nowMs: number = Date.now()): AgentHealth[] {
  const summariesByAgent = new Map<string, TokenSummary>()
  for (const s of getTokenSummary()) summariesByAgent.set(s.agent, s)

  const out: AgentHealth[] = []
  out.push(gatherAgentHealth(MAIN_AGENT_ID, { isMain: true, summariesByAgent }, nowMs))
  for (const name of listAgentNames()) {
    out.push(gatherAgentHealth(name, { isMain: false, summariesByAgent }, nowMs))
  }
  return out
}
