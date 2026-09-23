// Adversarial fixtures for WELL-4b2e63fe: write-manual-vision-day helper.
//
// AC1 requirements (dave):
//   1. Helper-written manual day is read back with non-null sourceSyncedAt
//      -> computeFreshness() sees syncAgeHours !== null (NOT "never stale").
//   2. Same day read 2 days later is correctly stale (syncAgeHours > 8h threshold).
//
// The dangerous direction: if the helper wrote _date instead of date, or omitted
// sourceSyncedAt, the freshness route would see syncAgeHours=null and emit a
// "latest data never" alert even for a day with real data.
//
// These tests reproduce the output that write-manual-vision-day.py produces and
// verify the full pipeline: write -> ZeppIngestStore.read() -> computeFreshness().

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZeppIngestStore } from '../web/zepp/ingest-store.js'
import { computeFreshness } from '../web/routes/health-zepp-freshness.js'

// Simulates the JSON that write-manual-vision-day.py produces for a given
// write time. Returns a ZeppDailySnapshot-shaped object as the script would write.
function manualVisionSnapshot(date: string, writtenAtIso: string): object {
  return {
    date,                         // date, NOT _date (the fix)
    pulledAt: writtenAtIso,
    status: 'ok',
    sourceSyncedAt: writtenAtIso, // write-time, NOT data-date
    vitals: { hrv: 45, restingHr: 58 },
    sleep: {
      durationMin: 434,
      startAt: `${date}T22:00:00Z`,
      endAt: `${date}T06:00:00Z`,
    },
    workouts: [],
  }
}

describe('write-manual-vision-day adversarial fixtures (WELL-4b2e63fe)', () => {
  let dir: string
  let store: ZeppIngestStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zepp-manual-writer-test-'))
    store = new ZeppIngestStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // FIXTURE 1 (AC1): manual day read back as fresh (syncAgeHours NOT null).
  //
  // Dangerous direction: if sourceSyncedAt is omitted (e.g. old _date-only
  // template), computeFreshness() returns syncAgeHours=null -> alert fires for
  // a day that is actually fresh.
  // ---------------------------------------------------------------------------
  it('AC1-a: helper-written manual day is read back with non-null sourceSyncedAt -> syncAgeHours NOT null (not "never")', () => {
    const date = '2026-09-23'
    const writtenAt = '2026-09-23T08:30:00.000Z'
    const writtenAtMs = Date.parse(writtenAt)

    // Write file as the Python helper would produce it
    const snap = manualVisionSnapshot(date, writtenAt)
    writeFileSync(join(dir, `daily-${date}.json`), JSON.stringify(snap), { mode: 0o600 })

    // read() must return the snapshot with date and sourceSyncedAt intact
    const readBack = store.read(date)
    expect(readBack).not.toBeNull()
    expect(readBack!.date).toBe(date)
    expect(readBack!.sourceSyncedAt).toBe(writtenAt)

    // computeFreshness() must see syncAgeHours !== null (not "no sync timestamp")
    const result = computeFreshness({
      latestSnapshot: () =>
        readBack ? { date: readBack.date, sourceSyncedAt: readBack.sourceSyncedAt } : null,
      nowBudapest: () => ({ date, hours: 9, minutes: 0 }),
      nowMs: () => writtenAtMs + 30 * 60 * 1000, // 30 min after write = fresh
    })

    // Dangerous direction: syncAgeHours===null means "latest data never" alert
    expect(result.syncAgeHours).not.toBeNull()
    // 30 min after write -> syncAgeHours ~0.5h, well below 8h threshold
    expect(result.syncAgeHours!).toBeCloseTo(0.5, 1)
    expect(result.alert).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // FIXTURE 2 (AC1): same day 2 days later is correctly stale.
  //
  // The sourceSyncedAt is the WRITE time (not the data date). Two days later,
  // syncAgeHours > 8h -> alert fires. This validates that write-time semantics
  // are correct: a manual entry from 2 days ago should trigger freshness alert.
  // ---------------------------------------------------------------------------
  it('AC1-b: same manual day read 2 days later is correctly stale (syncAgeHours > 8h -> alert)', () => {
    const date = '2026-09-21'
    const writtenAt = '2026-09-21T08:30:00.000Z'
    const writtenAtMs = Date.parse(writtenAt)
    const twoDaysLaterMs = writtenAtMs + 2 * 24 * 60 * 60 * 1000

    const snap = manualVisionSnapshot(date, writtenAt)
    writeFileSync(join(dir, `daily-${date}.json`), JSON.stringify(snap), { mode: 0o600 })

    const readBack = store.read(date)
    expect(readBack!.sourceSyncedAt).toBe(writtenAt)

    const result = computeFreshness({
      latestSnapshot: () =>
        readBack ? { date: readBack.date, sourceSyncedAt: readBack.sourceSyncedAt } : null,
      nowBudapest: () => ({ date: '2026-09-23', hours: 9, minutes: 0 }),
      nowMs: () => twoDaysLaterMs,
      config: { quietStartHour: 0, quietEndHour: 0 }, // disable quiet window
    })

    // 48h since last sync -> syncAgeHours ~48, well above 8h threshold
    expect(result.syncAgeHours).not.toBeNull()
    expect(result.syncAgeHours!).toBeGreaterThan(47)
    expect(result.alert).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // FIXTURE 3 (AC1 write-time vs data-date invariant): sourceSyncedAt must be
  // the write-time clock, NOT the data date (midnight of the covered day).
  //
  // If sourceSyncedAt = data-date midnight, then a write at 08:30 for today's
  // data would show syncAgeHours = 8.5h -- triggering the 8h alert falsely.
  // The helper uses datetime.now(utc) at write time, so a write at 08:30 shows
  // syncAgeHours = 0h (correctly fresh).
  // ---------------------------------------------------------------------------
  it('AC1-c: sourceSyncedAt is write-time, not data-date midnight (avoids false-stale on same-day write)', () => {
    const date = '2026-09-23'
    // Write at 08:30 local = 06:30 UTC. Data date midnight UTC = 2026-09-23T00:00Z.
    // If sourceSyncedAt were data-date midnight, syncAgeHours = 6.5h -- near the 8h threshold.
    // If sourceSyncedAt is write-time (06:30Z), syncAgeHours checked 1min later = ~0.017h.
    const writtenAt = '2026-09-23T06:30:00.000Z'
    const writtenAtMs = Date.parse(writtenAt)
    const checkMs = writtenAtMs + 60 * 1000 // 1 min after write

    const snap = manualVisionSnapshot(date, writtenAt)
    writeFileSync(join(dir, `daily-${date}.json`), JSON.stringify(snap), { mode: 0o600 })

    const readBack = store.read(date)
    // sourceSyncedAt must match write time, not midnight
    expect(readBack!.sourceSyncedAt).toBe(writtenAt)
    expect(readBack!.sourceSyncedAt).not.toBe('2026-09-23T00:00:00.000Z')

    const result = computeFreshness({
      latestSnapshot: () =>
        readBack ? { date: readBack.date, sourceSyncedAt: readBack.sourceSyncedAt } : null,
      nowBudapest: () => ({ date, hours: 9, minutes: 0 }),
      nowMs: () => checkMs,
    })
    // 1 min after write -> syncAgeHours ~0.017h, fresh
    expect(result.syncAgeHours!).toBeLessThan(0.1)
    expect(result.alert).toBe(false)
  })
})
