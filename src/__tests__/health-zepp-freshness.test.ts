import { describe, it, expect } from 'vitest'
import { computeFreshness, type ZeppFreshnessDeps } from '../web/routes/health-zepp-freshness.js'

// Default fixture: last sync 2026-08-24T12:00:00Z, "now" the same instant
// (Budapest 14:00 = 12:00 UTC in CEST) so age is 0h and nothing alerts unless a
// test moves the clock forward.
function makeDeps(over: Partial<ZeppFreshnessDeps> = {}): ZeppFreshnessDeps {
  return {
    latestSnapshot: () => ({ date: '2026-08-24', sourceSyncedAt: '2026-08-24T12:00:00Z' }),
    nowBudapest: () => ({ date: '2026-08-24', hours: 14, minutes: 0 }),
    nowMs: () => Date.parse('2026-08-24T12:00:00Z'),
    ...over,
  }
}

/** nowMs `hours` after the given ISO instant. */
function msAfter(iso: string, hours: number): number {
  return Date.parse(iso) + hours * 3_600_000
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

  describe('blocksSince1am (legacy informational field)', () => {
    it('returns 0 at exactly 01:00 Budapest (0 blocks elapsed)', () => {
      const r = computeFreshness(makeDeps({ nowBudapest: () => ({ date: '2026-08-24', hours: 1, minutes: 0 }) }))
      expect(r.blocksSince1am).toBe(0)
    })

    it('returns 0 before 01:00 (00:45)', () => {
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
  })

  describe('daysBehind (informational, no longer alert driver)', () => {
    it('is 0 when latest is today', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-24' }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 14, minutes: 0 }),
      }))
      expect(r.daysBehind).toBe(0)
    })

    it('is 1 when latest is yesterday (normal morning state)', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-23' }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 9, minutes: 0 }),
      }))
      expect(r.daysBehind).toBe(1)
    })

    it('is 6 across a real multi-day gap (08-25 -> 08-31)', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-25' }),
        nowBudapest: () => ({ date: '2026-08-31', hours: 9, minutes: 0 }),
      }))
      expect(r.daysBehind).toBe(6)
    })

    it('is null when store is empty', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => null,
        nowBudapest: () => ({ date: '2026-08-24', hours: 9, minutes: 0 }),
      }))
      expect(r.daysBehind).toBeNull()
    })

    it('spans a month boundary correctly (07-31 -> 08-02 = 2)', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-07-31' }),
        nowBudapest: () => ({ date: '2026-08-02', hours: 9, minutes: 0 }),
      }))
      expect(r.daysBehind).toBe(2)
    })
  })

  describe('syncAgeHours', () => {
    it('is 0 when now equals the sync timestamp', () => {
      const r = computeFreshness(makeDeps())
      expect(r.syncAgeHours).toBeCloseTo(0, 5)
    })

    it('reflects elapsed hours since last sync', () => {
      const sync = '2026-08-24T00:00:00Z'
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-24', sourceSyncedAt: sync }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 11, minutes: 0 }),
        nowMs: () => msAfter(sync, 9),
      }))
      expect(r.syncAgeHours).toBeCloseTo(9, 5)
    })

    it('is null when the snapshot has no sync timestamp', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-24' }),
      }))
      expect(r.syncAgeHours).toBeNull()
    })

    it('is null when store is empty', () => {
      const r = computeFreshness(makeDeps({ latestSnapshot: () => null }))
      expect(r.syncAgeHours).toBeNull()
    })

    it('is null when the sync timestamp is unparseable (never reads fresh)', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-24', sourceSyncedAt: 'not-a-date' }),
      }))
      expect(r.syncAgeHours).toBeNull()
    })
  })

  // Boss 09-02: the freshness alert is driven by LAST-SYNC AGE (> threshold),
  // not the data date, and is suppressed during the overnight quiet window.
  describe('alert logic (sync-age + quiet window)', () => {
    const sync = '2026-08-24T00:00:00Z'

    it('no alert when the last sync is fresh (< 8h) outside the quiet window', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-24', sourceSyncedAt: sync }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 12, minutes: 0 }),
        nowMs: () => msAfter(sync, 5),
      }))
      expect(r.alert).toBe(false)
      expect(r.alertReason).toBeNull()
    })

    it('alerts when the last sync is older than 8h outside the quiet window', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-23', sourceSyncedAt: sync }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 12, minutes: 0 }),
        nowMs: () => msAfter(sync, 12),
      }))
      expect(r.alert).toBe(true)
      expect(r.alertReason).toContain('12.0h since last sync')
      expect(r.alertReason).toContain('threshold 8h')
    })

    it('does NOT alert at exactly the threshold (8.0h -- strict greater-than)', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-24', sourceSyncedAt: sync }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 12, minutes: 0 }),
        nowMs: () => msAfter(sync, 8),
      }))
      expect(r.syncAgeHours).toBeCloseTo(8, 5)
      expect(r.alert).toBe(false)
    })

    it('alerts just past the threshold (8.1h)', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-24', sourceSyncedAt: sync }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 12, minutes: 0 }),
        nowMs: () => msAfter(sync, 8.1),
      }))
      expect(r.alert).toBe(true)
    })

    // The quiet window is the whole point of the overnight suppression: an aged
    // sync at 03:00 is expected and must NOT ping.
    it('SUPPRESSES an old-sync alert inside the quiet window (03:00)', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-23', sourceSyncedAt: sync }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 3, minutes: 0 }),
        nowMs: () => msAfter(sync, 20),
      }))
      expect(r.syncAgeHours).toBeCloseTo(20, 5)
      expect(r.inQuietWindow).toBe(true)
      expect(r.alert).toBe(false)
      expect(r.alertReason).toBeNull()
    })

    it('quiet window is inclusive of 00:00 (midnight is quiet)', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-23', sourceSyncedAt: sync }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 0, minutes: 0 }),
        nowMs: () => msAfter(sync, 20),
      }))
      expect(r.inQuietWindow).toBe(true)
      expect(r.alert).toBe(false)
    })

    it('quiet window is exclusive of 08:00 (08:00 can alert)', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-23', sourceSyncedAt: sync }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 8, minutes: 0 }),
        nowMs: () => msAfter(sync, 20),
      }))
      expect(r.inQuietWindow).toBe(false)
      expect(r.alert).toBe(true)
    })

    it('alerts when store is empty (no sync at all) outside the quiet window', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => null,
        nowBudapest: () => ({ date: '2026-08-24', hours: 14, minutes: 0 }),
      }))
      expect(r.syncAgeHours).toBeNull()
      expect(r.alert).toBe(true)
      expect(r.alertReason).toContain('no sync timestamp')
    })

    it('suppresses the empty-store alert inside the quiet window', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => null,
        nowBudapest: () => ({ date: '2026-08-24', hours: 5, minutes: 0 }),
      }))
      expect(r.alert).toBe(false)
    })

    it('treats a missing sync timestamp (date present) as stale and alerts', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-24' }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 14, minutes: 0 }),
      }))
      expect(r.alert).toBe(true)
    })
  })

  describe('config overrides', () => {
    const sync = '2026-08-24T00:00:00Z'

    it('exposes the effective threshold (default 8h)', () => {
      const r = computeFreshness(makeDeps())
      expect(r.thresholdHours).toBe(8)
    })

    it('honors a custom sync-age threshold', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-24', sourceSyncedAt: sync }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 12, minutes: 0 }),
        nowMs: () => msAfter(sync, 5),
        config: { syncAgeThresholdHours: 4 },
      }))
      expect(r.thresholdHours).toBe(4)
      expect(r.alert).toBe(true) // 5h > 4h
    })

    it('honors a custom quiet window (22:00-06:00 wrapping midnight)', () => {
      const atHour = (h: number) => computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-23', sourceSyncedAt: sync }),
        nowBudapest: () => ({ date: '2026-08-24', hours: h, minutes: 0 }),
        nowMs: () => msAfter(sync, 20),
        config: { quietStartHour: 22, quietEndHour: 6 },
      }))
      expect(atHour(23).inQuietWindow).toBe(true)  // after start
      expect(atHour(2).inQuietWindow).toBe(true)   // before end, past midnight
      expect(atHour(6).inQuietWindow).toBe(false)  // end exclusive
      expect(atHour(12).inQuietWindow).toBe(false) // daytime
    })

    it('an empty quiet window (start === end) never suppresses', () => {
      const r = computeFreshness(makeDeps({
        latestSnapshot: () => ({ date: '2026-08-23', sourceSyncedAt: sync }),
        nowBudapest: () => ({ date: '2026-08-24', hours: 3, minutes: 0 }),
        nowMs: () => msAfter(sync, 20),
        config: { quietStartHour: 0, quietEndHour: 0 },
      }))
      expect(r.inQuietWindow).toBe(false)
      expect(r.alert).toBe(true)
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
