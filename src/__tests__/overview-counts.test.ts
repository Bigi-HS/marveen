import { describe, it, expect, afterEach } from 'vitest'
import { computeOverviewCounts, type OverviewCountDeps } from '../web/routes/overview.js'
import { startOfBudapestDayMs } from '../db.js'

// WELL-027 C4: overview count integrity.
//   C4a -- the "tasks today" figure is the ARITHMETIC SUM of two independently
//          counted sources. This suite PINS the current (known, bounded) overlap;
//          real dedup is tracked separately in card 2fbfdb39.
//   C4b -- the day boundary must be pinned to Europe/Budapest, not the ambient
//          server TZ.

const DAY_MS = 24 * 60 * 60 * 1000

function makeDeps(over: Partial<OverviewCountDeps> = {}): OverviewCountDeps {
  return {
    nowMs: () => Date.parse('2026-09-20T10:00:00Z'),
    countTaskRuns: () => 0,
    countUserTurns: () => 0,
    ...over,
  }
}

describe('computeOverviewCounts', () => {
  describe('C4a: producer double-count (known overlap, dedup tracked in card 2fbfdb39)', () => {
    // tasksToday = countTaskRuns(scheduled task_runs) + countUserTurns(session
    // JSONL user-turns). These sources are NOT disjoint by construction: a
    // scheduled task writes a task_runs row AND its dispatched prompt can also
    // land as a plain user-turn in a session JSONL, so a single logical activity
    // is counted in BOTH sources. This test DELIBERATELY pins that arithmetic
    // add as the current bounded behavior -- it must NOT be "corrected" to expect
    // a de-duplicated (lower) number until event-identity dedup lands via card
    // 2fbfdb39. Asserting the double-counted total is intentional (pin the live
    // behavior, not the safe side).
    it('sums both sources arithmetically, double-counting an overlapping activity', () => {
      const counts = computeOverviewCounts(makeDeps({
        // 3 scheduled runs and 2 user-turns where the 2 user-turns represent the
        // SAME logical activity as 2 of the 3 runs (dispatched-prompt overlap).
        countTaskRuns: (from, to) => (to === undefined ? 3 : 0),
        countUserTurns: (from, to) => (to === undefined ? 2 : 0),
      }))
      // Known limitation: 3 + 2 = 5, with zero dedup even though the true
      // distinct count is 3. Pinned here; fixed under card 2fbfdb39.
      expect(counts.tasksToday).toBe(5)
    })

    it('sums both sources for the yesterday window as well', () => {
      const counts = computeOverviewCounts(makeDeps({
        countTaskRuns: (from, to) => (to === undefined ? 0 : 4),
        countUserTurns: (from, to) => (to === undefined ? 0 : 1),
      }))
      expect(counts.tasksYesterday).toBe(5)
    })

    it('passes the Budapest-pinned start-of-day as the "today" window start', () => {
      const nowMs = Date.parse('2026-09-20T10:00:00Z')
      let seenTodayFrom: number | undefined
      const counts = computeOverviewCounts(makeDeps({
        nowMs: () => nowMs,
        countTaskRuns: (from, to) => { if (to === undefined) seenTodayFrom = from; return 0 },
      }))
      expect(counts.startOfDayMs).toBe(startOfBudapestDayMs(nowMs))
      expect(seenTodayFrom).toBe(counts.startOfDayMs)
    })

    it('splits the yesterday window as [startOfDay - 24h, startOfDay)', () => {
      const nowMs = Date.parse('2026-09-20T10:00:00Z')
      let yesterdayFrom: number | undefined
      let yesterdayTo: number | undefined
      computeOverviewCounts(makeDeps({
        nowMs: () => nowMs,
        countTaskRuns: (from, to) => { if (to !== undefined) { yesterdayFrom = from; yesterdayTo = to } return 0 },
      }))
      const start = startOfBudapestDayMs(nowMs)
      expect(yesterdayTo).toBe(start)
      expect(yesterdayFrom).toBe(start - DAY_MS)
    })
  })
})

describe('startOfBudapestDayMs (C4b: day boundary pinned to Europe/Budapest)', () => {
  const savedTZ = process.env.TZ
  afterEach(() => {
    if (savedTZ === undefined) delete process.env.TZ
    else process.env.TZ = savedTZ
  })

  it('returns 00:00 Budapest (CEST, UTC+2) for a summer instant', () => {
    // 2026-09-20 12:00 Budapest (CEST) == 10:00 UTC. Midnight that day is
    // 2026-09-20 00:00 Budapest == 2026-09-19 22:00 UTC.
    expect(startOfBudapestDayMs(Date.parse('2026-09-20T10:00:00Z')))
      .toBe(Date.parse('2026-09-19T22:00:00Z'))
  })

  it('returns 00:00 Budapest (CET, UTC+1) for a winter instant (DST-aware)', () => {
    // 2026-01-15 11:00 Budapest (CET) == 10:00 UTC. Midnight that day is
    // 2026-01-15 00:00 Budapest == 2026-01-14 23:00 UTC. Offset differs from
    // summer, proving the boundary tracks CET<->CEST rather than a fixed offset.
    expect(startOfBudapestDayMs(Date.parse('2026-01-15T10:00:00Z')))
      .toBe(Date.parse('2026-01-14T23:00:00Z'))
  })

  it('rolls to the next Budapest day just after local midnight', () => {
    // 2026-09-20 22:30 UTC == 2026-09-21 00:30 Budapest -> new Budapest day.
    expect(startOfBudapestDayMs(Date.parse('2026-09-20T22:30:00Z')))
      .toBe(Date.parse('2026-09-20T22:00:00Z'))
  })

  it('stays on the same Budapest day late in the local evening', () => {
    // 2026-09-20 21:30 UTC == 2026-09-20 23:30 Budapest -> still Sep 20.
    expect(startOfBudapestDayMs(Date.parse('2026-09-20T21:30:00Z')))
      .toBe(Date.parse('2026-09-19T22:00:00Z'))
  })

  it('is independent of the ambient server TZ (the C4b regression)', () => {
    // The whole point: an operator/server in a far-off TZ must not shift the
    // "today" boundary. setHours(0,0,0,0) (the old code) WOULD shift here.
    process.env.TZ = 'Pacific/Kiritimati' // UTC+14
    const nowMs = Date.parse('2026-09-20T10:00:00Z')
    expect(startOfBudapestDayMs(nowMs)).toBe(Date.parse('2026-09-19T22:00:00Z'))
    process.env.TZ = 'Pacific/Midway' // UTC-11
    expect(startOfBudapestDayMs(nowMs)).toBe(Date.parse('2026-09-19T22:00:00Z'))
  })

  it('DST fall-back: offset sampled at midnight (still CEST), not at the post-transition input', () => {
    // 2026-10-25 fall-back: 03:00 CEST (UTC+2) -> 02:00 CET (UTC+1) at 01:00 UTC.
    // Input: 10:00 UTC -- AFTER the transition (CET in effect at the input moment).
    // The function samples tzOffsetSeconds at naiveUtcMs = 00:00 UTC on Oct 25,
    // which is 02:00 CEST -- still 45 minutes BEFORE the 01:00 UTC clock-back.
    // So the offset is CEST = +7200s, and midnight Budapest = Date.UTC(2026,9,24,22,0,0).
    //
    // Dangerous direction (old toLocaleString-style trick): sample offset at the
    // INPUT moment (10:00 UTC = CET = UTC+1 = +3600s) -> naiveUtcMs - 3600000
    //   = Date.UTC(2026,9,24,23,0,0) -- 1 hour too late. (C6-TZ-DST-FALL)
    expect(startOfBudapestDayMs(Date.UTC(2026, 9, 25, 10, 0, 0)))
      .toBe(Date.UTC(2026, 9, 24, 22, 0, 0))
  })
})
