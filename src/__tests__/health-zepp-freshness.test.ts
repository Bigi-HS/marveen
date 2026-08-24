import { describe, it, expect } from 'vitest'
import { computeFreshness, type ZeppFreshnessDeps } from '../web/routes/health-zepp-freshness.js'

function makeDeps(over: Partial<ZeppFreshnessDeps> = {}): ZeppFreshnessDeps {
  return {
    latestSnapshot: () => ({ date: '2026-08-24', sourceSyncedAt: '2026-08-24T12:00:00Z' }),
    nowBudapest: () => ({ date: '2026-08-24', hours: 14, minutes: 0 }),
    ...over,
  }
}

describe('computeFreshness', () => {
  describe('isToday', () => {
    it('returns isToday=true when latest date matches Budapest today', () => {
      const r = computeFreshness(makeDeps())
      expect(r.isToday).toBe(true)
      expect(r.alert).toBe(false)
      expect(r.alertReason).toBeNull()
    })

    it('returns isToday=false when latest date is yesterday', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-23', sourceSyncedAt: '2026-08-23T22:00:00Z' }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 14, minutes: 0 }),
      }))
      expect(r.isToday).toBe(false)
    })

    it('returns isToday=false and latestDate=null when store is empty', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => null,
        nowBudapest: () => ({ date: '2026-08-24', hours: 14, minutes: 0 }),
      }))
      expect(r.isToday).toBe(false)
      expect(r.latestDate).toBeNull()
    })
  })

  describe('blocksSince1am', () => {
    it('returns 0 at exactly 01:00 Budapest (0 blocks elapsed)', () => {
      const r = computeFreshness(makeDeps({ nowBudapest: () => ({ date: '2026-08-24', hours: 1, minutes: 0 }) }))
      expect(r.blocksSince1am).toBe(0)
    })

    it('returns 0 before 01:00 (midnight)', () => {
      const r = computeFreshness(makeDeps({ nowBudapest: () => ({ date: '2026-08-24', hours: 0, minutes: 45 }) }))
      expect(r.blocksSince1am).toBe(0)
    })

    it('returns 1 at 01:30 Budapest (1 block = 30 min elapsed)', () => {
      const r = computeFreshness(makeDeps({ nowBudapest: () => ({ date: '2026-08-24', hours: 1, minutes: 30 }) }))
      expect(r.blocksSince1am).toBe(1)
    })

    it('returns 3 at 02:30 Budapest (3 blocks = 90 min elapsed)', () => {
      const r = computeFreshness(makeDeps({ nowBudapest: () => ({ date: '2026-08-24', hours: 2, minutes: 30 }) }))
      expect(r.blocksSince1am).toBe(3)
    })

    it('returns 2 at 02:00 Budapest (2 blocks elapsed, no alert yet)', () => {
      const r = computeFreshness(makeDeps({ nowBudapest: () => ({ date: '2026-08-24', hours: 2, minutes: 0 }) }))
      expect(r.blocksSince1am).toBe(2)
    })
  })

  describe('alert logic', () => {
    it('no alert when data is today even if many blocks elapsed', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-24', sourceSyncedAt: '2026-08-24T12:00:00Z' }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 22, minutes: 0 }),
      }))
      expect(r.alert).toBe(false)
    })

    it('no alert when data is stale but fewer than 3 blocks elapsed (too early)', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-23', sourceSyncedAt: '2026-08-23T20:00:00Z' }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 2, minutes: 0 }),
      }))
      expect(r.blocksSince1am).toBe(2)
      expect(r.alert).toBe(false)
    })

    it('alerts when data is stale and exactly 3 blocks elapsed (02:30)', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-23', sourceSyncedAt: '2026-08-23T20:00:00Z' }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 2, minutes: 30 }),
      }))
      expect(r.blocksSince1am).toBe(3)
      expect(r.alert).toBe(true)
      expect(r.alertReason).toContain('2026-08-23')
      expect(r.alertReason).toContain('2026-08-24')
    })

    it('alerts when store is empty and 3+ blocks elapsed', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => null,
        nowBudapest: () => ({ date: '2026-08-24', hours: 14, minutes: 0 }),
      }))
      expect(r.alert).toBe(true)
      expect(r.alertReason).toContain('never')
    })

    it('alert includes block count in reason', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-23', sourceSyncedAt: '2026-08-23T20:00:00Z' }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 14, minutes: 0 }),
      }))
      expect(r.alertReason).toContain('26')
    })
  })

  describe('result shape', () => {
    it('returns latestDate and sourceSyncedAt from latest snapshot', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-23', sourceSyncedAt: '2026-08-23T22:15:00Z' }),
      }))
      expect(r.latestDate).toBe('2026-08-23')
      expect(r.sourceSyncedAt).toBe('2026-08-23T22:15:00Z')
    })

    it('returns null sourceSyncedAt when snapshot has none', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-24' }),
      }))
      expect(r.sourceSyncedAt).toBeNull()
    })

    it('checkedAt is an ISO string', () => {
      const r = computeFreshness(makeDeps())
      expect(r.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })
})
