import { describe, it, expect, afterEach } from 'vitest'
import { computeOverviewCounts, type OverviewCountDeps } from '../web/routes/overview.js'
import { startOfBudapestDayMs } from '../db.js'

// WELL-027 C4: overview count integrity.
//   C4a -- tasksToday is a DISJOINT UNION: countUserTurns excludes scheduled-task
//          echoes (already counted in task_runs), so arithmetic addition yields the
//          true distinct activity count. Dedup implemented in card 2fbfdb39.
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
  describe('C4a: disjoint union (scheduled echoes excluded from countUserTurns)', () => {
    // countUserTurns (production impl) filters out scheduled-task echoes before
    // returning -- those turns are already counted in task_runs. The deps seam here
    // receives already-filtered counts, so arithmetic addition equals the true
    // distinct activity count (no double-count).
    it('counts distinct activities: task_runs plus non-echo user turns', () => {
      const counts = computeOverviewCounts(makeDeps({
        // 3 scheduled runs today; countUserTurns returns 4 genuine (non-echo) turns.
        countTaskRuns: (from, to) => (to === undefined ? 3 : 0),
        countUserTurns: (from, to) => (to === undefined ? 4 : 0),
      }))
      // Disjoint: 3 + 4 = 7 distinct activities.
      expect(counts.tasksToday).toBe(7)
    })

    it('counts yesterday\'s distinct activities the same way', () => {
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
})
