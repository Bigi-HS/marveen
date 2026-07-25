import { describe, it, expect } from 'vitest'
import {
  evaluateFreshness,
  decideFreshnessAlerts,
  freshnessAlertContent,
  runFreshnessCheck,
  FRESHNESS_THRESHOLD_SECONDS,
  FRESHNESS_REALERT_SUPPRESS_SECONDS,
  FRESHNESS_OWNERS,
  type FreshnessAlert,
  type FreshnessAlertState,
} from '../todo-freshness.js'

// Card 9ad7334e: TS-native, in-process port of scripts/todo-freshness-check.py.
// DoD guardrails proven here: a genuine >26h staleness STILL alerts; benign
// no-rows never alerts; suppression prevents re-alert storms.

const HOUR = 3600

describe('evaluateFreshness', () => {
  const ago: Record<string, number | null> = {
    fresh: 2 * HOUR,
    stale: 30 * HOUR,
    empty: null,
    boundary: FRESHNESS_THRESHOLD_SECONDS, // exactly at threshold = NOT stale (> is strict)
    justOver: FRESHNESS_THRESHOLD_SECONDS + 1,
  }
  const agoFn = (o: string): number | null => ago[o] ?? null

  it('classifies ok / stale / no-rows', () => {
    const v = evaluateFreshness(['fresh', 'stale', 'empty'], agoFn)
    expect(v).toEqual([
      { owner: 'fresh', state: 'ok', ago: 2 * HOUR },
      { owner: 'stale', state: 'stale', ago: 30 * HOUR },
      { owner: 'empty', state: 'no-rows', ago: null },
    ])
  })

  it('threshold is strict: exactly-at-threshold is ok, one second over is stale', () => {
    const v = evaluateFreshness(['boundary', 'justOver'], agoFn)
    expect(v.find((x) => x.owner === 'boundary')!.state).toBe('ok')
    expect(v.find((x) => x.owner === 'justOver')!.state).toBe('stale')
  })
})

describe('freshnessAlertContent', () => {
  it('floors the age to whole hours', () => {
    expect(freshnessAlertContent('hibiki', 30 * HOUR + 1800)).toBe(
      'FRESHNESS ALERT: hibiki has not written to todo_items in 30h. Check agent health.',
    )
  })
})

describe('decideFreshnessAlerts', () => {
  const now = 1_000_000

  it('alerts a freshly-stale owner and stamps the state', () => {
    const verdicts = [{ owner: 'claudia', state: 'stale' as const, ago: 40 * HOUR }]
    const d = decideFreshnessAlerts(verdicts, {}, now, FRESHNESS_REALERT_SUPPRESS_SECONDS)
    expect(d.alerts).toHaveLength(1)
    expect(d.alerts[0].owner).toBe('claudia')
    expect(d.nextState.claudia).toBe(now)
  })

  it('suppresses a repeat alert within the suppression window', () => {
    const verdicts = [{ owner: 'claudia', state: 'stale' as const, ago: 40 * HOUR }]
    const recent = { claudia: now - 1 * HOUR } // alerted 1h ago, window is 23h
    const d = decideFreshnessAlerts(verdicts, recent, now, FRESHNESS_REALERT_SUPPRESS_SECONDS)
    expect(d.alerts).toHaveLength(0)
    expect(d.nextState.claudia).toBe(now - 1 * HOUR) // marker unchanged
  })

  it('re-alerts once the suppression window has elapsed', () => {
    const verdicts = [{ owner: 'claudia', state: 'stale' as const, ago: 40 * HOUR }]
    const old = { claudia: now - 24 * HOUR } // beyond the 23h window
    const d = decideFreshnessAlerts(verdicts, old, now, FRESHNESS_REALERT_SUPPRESS_SECONDS)
    expect(d.alerts).toHaveLength(1)
    expect(d.nextState.claudia).toBe(now)
  })

  it('a recovered/empty owner clears its prior alert marker', () => {
    const verdicts = [
      { owner: 'claudia', state: 'ok' as const, ago: 1 * HOUR },
      { owner: 'hibiki', state: 'no-rows' as const, ago: null },
    ]
    const prior: FreshnessAlertState = { claudia: now - 1 * HOUR, hibiki: now - 1 * HOUR }
    const d = decideFreshnessAlerts(verdicts, prior, now, FRESHNESS_REALERT_SUPPRESS_SECONDS)
    expect(d.alerts).toHaveLength(0)
    expect(d.nextState).toEqual({})
  })

  it('does not mutate the input state', () => {
    const verdicts = [{ owner: 'claudia', state: 'stale' as const, ago: 40 * HOUR }]
    const input: FreshnessAlertState = {}
    decideFreshnessAlerts(verdicts, input, now, FRESHNESS_REALERT_SUPPRESS_SECONDS)
    expect(input).toEqual({})
  })
})

describe('runFreshnessCheck (orchestration with injected IO)', () => {
  const now = 2_000_000

  function harness(agoByOwner: Record<string, number | null>, initial: FreshnessAlertState = {}) {
    let saved: FreshnessAlertState | null = null
    const sent: FreshnessAlert[] = []
    const deps = {
      now,
      agoFn: (o: string) => (o in agoByOwner ? agoByOwner[o] : null),
      loadState: () => ({ ...initial }),
      saveState: (s: FreshnessAlertState) => { saved = s },
      send: (a: FreshnessAlert) => { sent.push(a) },
      owners: ['claudia', 'hibiki'] as const,
    }
    return { deps, sent, getSaved: () => saved }
  }

  it('sends an alert and persists state for a stale owner', () => {
    const { deps, sent, getSaved } = harness({ claudia: 40 * HOUR, hibiki: 2 * HOUR })
    const r = runFreshnessCheck(deps)
    expect(r.sent).toBe(true)
    expect(r.alerts).toEqual([{ owner: 'claudia', ago: 40 * HOUR }])
    expect(sent).toHaveLength(1)
    expect(sent[0].content).toContain('claudia')
    expect(getSaved()!.claudia).toBe(now)
  })

  it('sends nothing when all owners are fresh/empty', () => {
    const { deps, sent } = harness({ claudia: 1 * HOUR, hibiki: null })
    const r = runFreshnessCheck(deps)
    expect(r.sent).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('respects suppression from loaded state (no duplicate send)', () => {
    const { deps, sent } = harness({ claudia: 40 * HOUR, hibiki: 2 * HOUR }, { claudia: now - 1 * HOUR })
    const r = runFreshnessCheck(deps)
    expect(r.sent).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('dry-run reports would-alert but never sends or persists (ignores suppression)', () => {
    const { deps, sent, getSaved } = harness({ claudia: 40 * HOUR, hibiki: 2 * HOUR }, { claudia: now - 1 * HOUR })
    const r = runFreshnessCheck({ ...deps, dryRun: true })
    expect(r.dryRun).toBe(true)
    expect(r.sent).toBe(false)
    expect(r.alerts).toEqual([{ owner: 'claudia', ago: 40 * HOUR }]) // would alert despite suppression
    expect(sent).toHaveLength(0)
    expect(getSaved()).toBeNull() // never persisted
  })

  it('defaults to the documented owner/threshold/suppress constants', () => {
    expect(FRESHNESS_OWNERS).toEqual(['claudia', 'hibiki'])
    expect(FRESHNESS_THRESHOLD_SECONDS).toBe(93600)
    expect(FRESHNESS_REALERT_SUPPRESS_SECONDS).toBe(23 * 3600)
  })
})
