// Agent-status realtime push watcher (card edf73bd7 F2, parent 513b8fd6).
//
// F1 (PR#322) built the server SSE (/api/events/stream) + client useEventStream,
// but left the fleet status grid on a 5s poll. The per-agent activity label
// (working / idle / stopped) is computed LIVE per GET in /api/agents/activity
// (capturePane + detectPaneState) with no stored value and no mutation point, so
// nothing can emit on it. This watcher is that missing producer: one central
// interval reads each session, diffs the coarse label, and pushes a thin-notify
// on a STABILISED transition only.
//
// Why one central watcher instead of leaving clients to poll: a single capture
// per tick is cheaper than N dashboard clients each capturing every few seconds,
// and it gives sub-5s push latency without a per-client poll storm.
//
// Egress (Trap-2, marveen ACK): the SSE frame is STRICT ID-ONLY -- {type,id}, no
// label, no pane content. The client re-reads the coarse status from the gated
// /api/agents + /api/agents/health GETs. Uniform with the F1 thin-notify
// invariant: the stream is a refetch trigger, never a content channel.

import { logger } from '../logger.js'
import { capturePane, isAgentRunning, agentSessionName } from './agent-process.js'
import { listAgentNames } from './agent-config.js'
import { MAIN_AGENT_ID } from '../config.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { computeAgentActivityLabel, type AgentActivityLabel } from '../pane-state.js'
import { emitDashboardEvent } from '../event-bus.js'
import { checkPaneDetectorGate } from './pane-detector-gate.js'

// Poll cadence (LOCKED tuning, marveen ACK): 2.5s interval + 2-tick stability
// => a transition is confirmed in ~5s, staying close to the prior 3s client poll
// (no freshness regression) while a single-tick flicker is suppressed.
export const WATCH_INTERVAL_MS = 2_500
export const STABILITY_TICKS = 2
// Offset the first tick so this pane-reader does not collide with the other
// capture-pane watchers (stuck-input 15s/20s, channel-monitor 30s, etc.).
export const INITIAL_DELAY_MS = 7_000

export interface AgentObservation {
  name: string
  label: AgentActivityLabel
}

export interface AgentStatusEntry {
  // The label most recently PUSHED for this agent (the debounce baseline).
  lastEmitted: AgentActivityLabel
  // The label observed on the current run of consecutive identical observations.
  candidate: AgentActivityLabel
  // How many consecutive ticks `candidate` has held.
  stableCount: number
}

export type AgentStatusState = Record<string, AgentStatusEntry>

/**
 * Pure debounce/transition core. Given the previous per-agent state and this
 * tick's observations, return the next state and the list of agent ids to push.
 *
 * Rules:
 *   - First sight of an agent SEEDS its baseline and never emits (transition-only;
 *     the client establishes initial status via its own first fetch, so there is
 *     no boot-time refetch burst).
 *   - A label only emits once it DIFFERS from the last-emitted label AND has held
 *     for `stabilityTicks` consecutive observations. A single-tick flicker
 *     (idle -> working -> idle) therefore never emits.
 *   - The input is the coarse label, so raw pane-tail churn is invisible here.
 */
export function reduceAgentStatus(
  prev: AgentStatusState,
  observations: AgentObservation[],
  stabilityTicks: number = STABILITY_TICKS,
): { next: AgentStatusState; emit: string[] } {
  const next: AgentStatusState = { ...prev }
  const emit: string[] = []

  for (const { name, label } of observations) {
    const entry = next[name]
    if (!entry) {
      next[name] = { lastEmitted: label, candidate: label, stableCount: 1 }
      continue
    }

    let candidate = entry.candidate
    let stableCount = entry.stableCount
    if (label === candidate) {
      stableCount += 1
    } else {
      candidate = label
      stableCount = 1
    }

    let lastEmitted = entry.lastEmitted
    if (candidate !== lastEmitted && stableCount >= stabilityTicks) {
      emit.push(name)
      lastEmitted = candidate
    }

    next[name] = { lastEmitted, candidate, stableCount }
  }

  return { next, emit }
}

// Read every fleet session once and map it to a coarse activity label. The main
// agent runs in the --channels session, not agent-<name> (parity with the
// /api/agents/activity route).
function observeFleet(): AgentObservation[] {
  const obs: AgentObservation[] = []

  const mainPane = capturePane(MAIN_CHANNELS_SESSION)
  obs.push({ name: MAIN_AGENT_ID, label: computeAgentActivityLabel(mainPane !== null, mainPane) })

  for (const name of listAgentNames()) {
    const running = isAgentRunning(name)
    const pane = running ? capturePane(agentSessionName(name)) : null
    obs.push({ name, label: computeAgentActivityLabel(running, pane) })
  }

  return obs
}

function emitAgentStatus(name: string): void {
  // STRICT id-only frame -- never the label or any pane content (egress invariant).
  emitDashboardEvent({ type: 'agent-status', id: name })
}

// Module-level state for the running watcher. Held here (not in the closure) so
// the imperative tick stays injectable and unit-testable.
let watcherState: AgentStatusState = {}

/**
 * One watcher tick. Deps are injectable for tests; production uses the real
 * fleet observer and the event-bus emitter.
 */
export function runAgentStatusTick(
  observe: () => AgentObservation[] = observeFleet,
  emit: (name: string) => void = emitAgentStatus,
  stabilityTicks: number = STABILITY_TICKS,
): void {
  const { next, emit: names } = reduceAgentStatus(watcherState, observe(), stabilityTicks)
  watcherState = next
  for (const name of names) emit(name)
}

// Test hook: clear the accumulated baseline between cases.
export function __resetAgentStatusState(): void {
  watcherState = {}
}

export function startAgentStatusWatcher(): NodeJS.Timeout {
  function sweep(): void {
    // Stand down on a Claude CLI drift until a pane-detector smoke re-validates
    // it: a transition verdict rests on detectPaneState, which an unverified CLI
    // render could misclassify into a spurious flip. Same gate the other
    // pane-reading watchers use.
    if (!checkPaneDetectorGate('agent-status')) return
    try {
      runAgentStatusTick()
    } catch (err) {
      logger.debug({ err }, 'agent-status-watcher: tick error')
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, WATCH_INTERVAL_MS)
}
