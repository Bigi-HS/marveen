// AIDefence pipeline health probe (card ef918983).
//
// Verifies end-to-end that:
//   1. aiDefenceGuard() returns the expected verdict for a known FLAG input.
//   2. recordGuardEvent() persists a row to guard_events.
//
// Gap this closes: if recording is silently broken, guard_events stays at 0
// and Chad's daily report looks clean while the pipeline is dead (SEC-055).

import { aiDefenceGuard, type Verdict, type Severity } from '../aidefence-guard.js'
import { recordGuardEvent, type GuardEventInput } from './guard-event-recorder.js'
import { getGuardEvents } from '../db.js'

const PROBE_FROM = 'aidefence-probe'
// FLAG-triggering content: email PII (medium severity, FLAG verdict).
// NOT an injection pattern to avoid inflating the block-rate metric.
const PROBE_CONTENT = 'Contact probe@aidefence-health.internal for support'
const PROBE_EXPECTED_VERDICT: Verdict = 'FLAG'

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 }

export interface AiDefenceProbeResult {
  ok: boolean
  verdict: Verdict | string
  verdictMatch: boolean
  recorded: boolean
}

export interface AiDefenceProbeDeps {
  guard: typeof aiDefenceGuard
  record: (input: GuardEventInput, nowSec?: number) => void
  getEvents: typeof getGuardEvents
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

  return {
    ok: verdictMatch && recorded,
    verdict: guardResult.verdict,
    verdictMatch,
    recorded,
  }
}

const DEFAULT_DEPS: AiDefenceProbeDeps = {
  guard: aiDefenceGuard,
  record: recordGuardEvent,
  getEvents: getGuardEvents,
  nowSec: () => Math.floor(Date.now() / 1000),
}
