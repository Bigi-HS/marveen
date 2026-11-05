// AIDefence pipeline health probe (card ef918983).
//
// Verifies end-to-end that:
//   1. aiDefenceGuard() returns the expected verdict for a known FLAG input.
//   2. recordGuardEvent() persists a row to guard_events.
//   3. Real /api/messages traffic is generating guard_events (liveness denominator).
//
// Gap this closes: if recording is silently broken, guard_events stays at 0
// and Chad's daily report looks clean while the pipeline is dead (SEC-055).
//
// Liveness denominator (A-3 fix): distinguishes "quiet period" from "guard dead"
// by cross-checking non-coordinator route messages vs non-probe guard_events.
// DEAD only fires when route traffic existed but generated no guard_events.

import { aiDefenceGuard, type Verdict, type Severity } from '../aidefence-guard.js'
import { recordGuardEvent, type GuardEventInput } from './guard-event-recorder.js'
import { getGuardEvents, countNonCoordinatorMessages } from '../db.js'
import { COORDINATOR_AGENT_ID } from '../channel-coordinator/ingest.js'

const PROBE_FROM = 'aidefence-probe'
// FLAG-triggering content: email PII (medium severity, FLAG verdict).
// NOT an injection pattern to avoid inflating the block-rate metric.
export const PROBE_CONTENT = 'Contact probe@aidefence-health.internal for support'
export const PROBE_EXPECTED_VERDICT: Verdict = 'FLAG'

// Look-back window for the liveness denominator check (1 hour).
const LIVENESS_WINDOW_SEC = 3600

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 }

export type LivenessState = 'alive' | 'dead' | 'unknown'

export interface AiDefenceProbeResult {
  ok: boolean
  verdict: Verdict | string
  verdictMatch: boolean
  recorded: boolean
  liveness: LivenessState
  livenessDetail: { routeMessages: number; nonProbeGuardEvents: number }
}

export interface AiDefenceProbeDeps {
  guard: typeof aiDefenceGuard
  record: (input: GuardEventInput, nowSec?: number) => void
  getEvents: typeof getGuardEvents
  countNonCoordinatorMessages: (sinceSec: number) => number
  nowSec: () => number
}

export function runAiDefenceProbe(deps: AiDefenceProbeDeps = DEFAULT_DEPS): AiDefenceProbeResult {
  const nowSec = deps.nowSec()

  const beforeRows = deps.getEvents(200, nowSec).filter(r => r.from_agent === PROBE_FROM)
  const before = beforeRows.length

  const guardResult = deps.guard(PROBE_FROM, PROBE_CONTENT)

  const maxSev = guardResult.findings.reduce<Severity | null>(
    (best, f) => best === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best] ? f.severity : best,
    null,
  )

  let recordError = false
  try {
    deps.record({
      mechanism: 'messages-guard',
      route: '/api/messages',
      verdict: guardResult.verdict,
      fromAgent: PROBE_FROM,
      toAgent: null,
      patternIds: guardResult.findings.length > 0
        ? [...new Set(guardResult.findings.map(f => f.pattern))].sort().join(',')
        : null,
      maxSeverity: maxSev,
      findingCount: guardResult.findings.length,
      content: PROBE_CONTENT,
    }, nowSec)
  } catch {
    recordError = true
  }

  const after = recordError
    ? before
    : deps.getEvents(200, nowSec).filter(r => r.from_agent === PROBE_FROM).length

  const verdictMatch = guardResult.verdict === PROBE_EXPECTED_VERDICT
  const recorded = after > before

  // Liveness denominator: check if real route traffic generated guard_events.
  // routeMessages = messages that came through POST /api/messages (non-coordinator).
  // nonProbeGuardEvents = guard_events rows that are NOT synthetic probe rows.
  // DEAD only when route traffic existed but guard_events shows nothing for it.
  const windowStart = nowSec - LIVENESS_WINDOW_SEC
  const routeMessages = deps.countNonCoordinatorMessages(windowStart)
  const windowEvents = deps.getEvents(1000, windowStart)
  const nonProbeGuardEvents = windowEvents.filter(r => r.from_agent !== PROBE_FROM).length

  let liveness: LivenessState
  if (routeMessages === 0) {
    liveness = 'unknown'
  } else if (nonProbeGuardEvents > 0) {
    liveness = 'alive'
  } else {
    liveness = 'dead'
  }

  return {
    ok: verdictMatch && recorded && liveness !== 'dead',
    verdict: guardResult.verdict,
    verdictMatch,
    recorded,
    liveness,
    livenessDetail: { routeMessages, nonProbeGuardEvents },
  }
}

const DEFAULT_DEPS: AiDefenceProbeDeps = {
  guard: aiDefenceGuard,
  record: recordGuardEvent,
  getEvents: getGuardEvents,
  countNonCoordinatorMessages: (sinceSec: number) => countNonCoordinatorMessages(sinceSec, COORDINATOR_AGENT_ID),
  nowSec: () => Math.floor(Date.now() / 1000),
}
