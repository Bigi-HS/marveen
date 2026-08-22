import { detectPaneState, type PaneState } from '../pane-state.js'
import { captureProcEnvScan, type ProcEnvScan } from './channel-poller-reap.js'
import { recoverPipeFromPane } from './channel-health-monitor.js'

// Card 667281e4: when a pane finishes a turn (busy -> idle) and the Telegram/
// channel MCP pipe is silently dead, recover NOW instead of waiting up to ~60s
// for the next channel-health-monitor tick. We piggy-back on the existing 15s
// stuck-input-watcher pane capture (zero new capture overhead) and only act on
// the busy->idle EDGE, so a healthy agent merely idling between turns costs
// nothing beyond a state-map compare.
//
// The ~15s (stuck-input-watcher cadence), not the spec's aspirational ~2s, is
// deliberate: ~2s would need a dedicated fleet-wide 2-5s pane poll, i.e. a
// continuous tmux-capture on every agent every tick -- pure overhead the fleet
// forbids, and pointless because inbound messages QUEUE (nothing is lost) so a
// background pipe heal within ~15s is ample. (NoA decision, option C.)

// Pure edge detector: only a genuine busy->idle transition qualifies. A working
// agent's between-turn idle that was already idle last tick (idle->idle) does
// NOT fire; neither does typing/unknown/error -> idle.
export function isBusyToIdleTransition(prev: PaneState | null, curr: PaneState): boolean {
  return prev === 'busy' && curr === 'idle'
}

// Injectable IO so the wiring is unit-testable without tmux/ps.
export interface IdlePipeRecoveryDeps {
  detect: (pane: string) => PaneState
  recover: (agentName: string, pane: string, psScan: ProcEnvScan) => void
  getPsScan: () => ProcEnvScan
}

let deps: IdlePipeRecoveryDeps = {
  detect: detectPaneState,
  recover: recoverPipeFromPane,
  getPsScan: captureProcEnvScan,
}

export function __setIdlePipeRecoveryDeps(d: Partial<IdlePipeRecoveryDeps>): void {
  deps = { ...deps, ...d }
}

export function __resetIdlePipeRecoveryDeps(): void {
  deps = { detect: detectPaneState, recover: recoverPipeFromPane, getPsScan: captureProcEnvScan }
}

const prevPaneState = new Map<string, PaneState>()

export function __resetIdlePipeRecoveryState(): void {
  prevPaneState.clear()
}

// Forget an agent's last state (e.g. when it stops running) so a fresh start is
// not read as a transition.
export function clearIdlePipeRecoveryAgent(agentName: string): void {
  prevPaneState.delete(agentName)
}

// Feed one captured pane for an agent. Tracks the busy->idle edge and, on that
// edge only, lets recoverPipeFromPane decide whether the pipe is actually down
// (it probes the poller and reconnects with the SHARED backoff). A healthy pipe
// at the edge => the probe finds the poller present => no reconnect, so a normal
// turn-end never nudges a healthy agent (the false-positive guard).
export function checkIdlePipeRecovery(agentName: string, pane: string): void {
  const curr = deps.detect(pane)
  const prev = prevPaneState.get(agentName) ?? null
  prevPaneState.set(agentName, curr)
  if (isBusyToIdleTransition(prev, curr)) {
    deps.recover(agentName, pane, deps.getPsScan())
  }
}
