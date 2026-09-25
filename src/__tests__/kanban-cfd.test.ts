/**
 * GET /api/kanban/cfd + POST /api/kanban/cfd/snapshot
 * Tests for the kanban Cumulative Flow Diagram snapshot route (card b60d578c).
 *
 * Stores/reads from analytics_snapshots with source='kanban_cfd'.
 * The metrics_json blob: { planned, in_progress, waiting, done }.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import {
  buildCfdSnapshot,
  upsertCfdSnapshot,
  listCfdSnapshots,
  buildCfdSeries,
  type CfdMetrics,
} from '../web/routes/kanban-cfd.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
})

beforeEach(() => {
  getNoaDb().prepare("DELETE FROM analytics_snapshots WHERE source = 'kanban_cfd'").run()
})

// ---------------------------------------------------------------------------
// buildCfdSnapshot
// ---------------------------------------------------------------------------
describe('buildCfdSnapshot', () => {
  it('counts cards by status from kanban_cards', () => {
    const db = getNoaDb()
    db.prepare(`DELETE FROM kanban_cards`).run()
    db.prepare(`INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at)
      VALUES ('a','A','planned','normal',1,0,0),('b','B','planned','normal',2,0,0),
             ('c','C','in_progress','normal',3,0,0),
             ('d','D','waiting','normal',4,0,0),
             ('e','E','done','normal',5,0,0),('f','F','done','normal',6,0,0),('g','G','done','normal',7,0,0)`).run()

    const snap = buildCfdSnapshot(db)
    expect(snap.planned).toBe(2)
    expect(snap.in_progress).toBe(1)
    expect(snap.waiting).toBe(1)
    expect(snap.done).toBe(3)
  })

  it('excludes icebox cards from the count', () => {
    const db = getNoaDb()
    db.prepare(`DELETE FROM kanban_cards`).run()
    db.prepare(`INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at)
      VALUES ('a','A','planned','normal',1,0,0),('z','Z','icebox','normal',2,0,0)`).run()

    const snap = buildCfdSnapshot(db)
    expect(snap.planned).toBe(1)
    expect(snap.in_progress).toBe(0)
    expect(snap.waiting).toBe(0)
    expect(snap.done).toBe(0)
  })

  it('returns all-zero when table is empty', () => {
    const db = getNoaDb()
    db.prepare(`DELETE FROM kanban_cards`).run()

    const snap = buildCfdSnapshot(db)
    expect(snap).toEqual({ planned: 0, in_progress: 0, waiting: 0, done: 0, other: 0 })
  })
})

// ---------------------------------------------------------------------------
// C7a (card 27c75118): the four flow buckets + `other` must sum to the count of
// all active (non-icebox) cards. An unexpected/new status must be surfaced in
// `other`, never silently dropped (which reads as flow shrinking).
// ---------------------------------------------------------------------------
describe('buildCfdSnapshot -- C7a completeness (no silent drop of unknown status)', () => {
  it('routes an unexpected status into the `other` bucket instead of dropping it', () => {
    const db = getNoaDb()
    db.prepare(`DELETE FROM kanban_cards`).run()
    db.prepare(`INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at)
      VALUES ('a','A','planned','normal',1,0,0),
             ('b','B','blocked','normal',2,0,0),
             ('c','C','review','normal',3,0,0)`).run()

    const snap = buildCfdSnapshot(db)
    expect(snap.planned).toBe(1)
    // 'blocked' and 'review' are not flow statuses and not icebox -> surfaced.
    expect(snap.other).toBe(2)
  })

  it('all buckets sum to the count of every active (non-icebox) card', () => {
    const db = getNoaDb()
    db.prepare(`DELETE FROM kanban_cards`).run()
    db.prepare(`INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at)
      VALUES ('a','A','planned','normal',1,0,0),
             ('b','B','in_progress','normal',2,0,0),
             ('c','C','waiting','normal',3,0,0),
             ('d','D','done','normal',4,0,0),
             ('e','E','blocked','normal',5,0,0),
             ('z','Z','icebox','normal',6,0,0)`).run()

    const snap = buildCfdSnapshot(db)
    const sum = snap.planned + snap.in_progress + snap.waiting + snap.done + snap.other
    const active = db.prepare(
      `SELECT COUNT(*) AS n FROM kanban_cards WHERE status != 'icebox'`
    ).get() as { n: number }
    expect(sum).toBe(active.n)
    expect(sum).toBe(5) // icebox 'Z' excluded
    expect(snap.other).toBe(1) // 'blocked'
  })

  it('still excludes icebox and keeps `other` at 0 for a clean board', () => {
    const db = getNoaDb()
    db.prepare(`DELETE FROM kanban_cards`).run()
    db.prepare(`INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at)
      VALUES ('a','A','planned','normal',1,0,0),('z','Z','icebox','normal',2,0,0)`).run()

    const snap = buildCfdSnapshot(db)
    expect(snap.other).toBe(0)
    expect(snap.planned).toBe(1)
  })

  it('three distinct unknown statuses each route to other; sum of all buckets equals active (non-icebox) count', () => {
    // Card 44783957 boundary: 3 different unknown values -- 'blocked', 'review',
    // 'custom' -- must ALL land in `other` (not silently dropped or collapsed into
    // one). The flow buckets fill normally from the known statuses. Icebox excluded.
    // Dangerous direction: a schema/query that only handles ONE unknown value per
    // snapshot, or that COUNTs unknown statuses collectively rather than per-status,
    // would collapse them and the total would fall below the actual active card count.
    const db = getNoaDb()
    db.prepare(`DELETE FROM kanban_cards`).run()
    db.prepare(`INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at)
      VALUES ('a','A','blocked','normal',1,0,0),
             ('b','B','review','normal',2,0,0),
             ('c','C','custom','normal',3,0,0),
             ('d','D','planned','normal',4,0,0),
             ('e','E','planned','normal',5,0,0),
             ('f','F','in_progress','normal',6,0,0),
             ('z','Z','icebox','normal',7,0,0)`).run()

    const snap = buildCfdSnapshot(db)
    expect(snap.other).toBe(3)   // blocked + review + custom
    expect(snap.planned).toBe(2)
    expect(snap.in_progress).toBe(1)
    const sum = snap.planned + snap.in_progress + snap.waiting + snap.done + snap.other
    expect(sum).toBe(6)          // 7 cards - 1 icebox
  })
})

// ---------------------------------------------------------------------------
// C7b (card 27c75118): a calendar date with no snapshot must be representable
// as an explicit gap, not silently interpolated across by the chart consumer.
// ---------------------------------------------------------------------------
describe('buildCfdSeries -- C7b missing-day gaps', () => {
  it('marks a missing calendar day between snapshots as an explicit gap', () => {
    const rows = [
      { date: '2026-08-01', planned: 1, in_progress: 0, waiting: 0, done: 0, other: 0 },
      { date: '2026-08-03', planned: 2, in_progress: 0, waiting: 0, done: 0, other: 0 },
    ]
    const series = buildCfdSeries(rows)
    expect(series.map(p => p.date)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03'])
    expect(series.map(p => p.present)).toEqual([true, false, true])
    // The gap point carries no real numbers to interpolate from.
    const gap = series.find(p => p.date === '2026-08-02')!
    expect(gap.present).toBe(false)
  })

  it('leaves a contiguous run with no gaps (all present)', () => {
    const rows = [
      { date: '2026-08-01', planned: 1, in_progress: 0, waiting: 0, done: 0, other: 0 },
      { date: '2026-08-02', planned: 2, in_progress: 0, waiting: 0, done: 0, other: 0 },
    ]
    const series = buildCfdSeries(rows)
    expect(series).toHaveLength(2)
    expect(series.every(p => p.present)).toBe(true)
  })

  it('handles empty input and a single row', () => {
    expect(buildCfdSeries([])).toEqual([])
    const one = buildCfdSeries([{ date: '2026-08-05', planned: 3, in_progress: 0, waiting: 0, done: 0, other: 0 }])
    expect(one).toHaveLength(1)
    expect(one[0].present).toBe(true)
  })

  it('preserves real metrics on present days and spans a multi-day gap', () => {
    const rows = [
      { date: '2026-08-01', planned: 5, in_progress: 1, waiting: 0, done: 2, other: 0 },
      { date: '2026-08-05', planned: 6, in_progress: 0, waiting: 1, done: 3, other: 1 },
    ]
    const series = buildCfdSeries(rows)
    expect(series.map(p => p.date)).toEqual([
      '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05',
    ])
    expect(series.map(p => p.present)).toEqual([true, false, false, false, true])
    expect(series[0].planned).toBe(5)
    expect(series[4].done).toBe(3)
    expect(series[4].other).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// upsertCfdSnapshot + listCfdSnapshots
// ---------------------------------------------------------------------------
describe('upsertCfdSnapshot', () => {
  it('inserts a new row for a date', () => {
    const db = getNoaDb()
    const metrics: CfdMetrics = { planned: 5, in_progress: 2, waiting: 1, done: 10, other: 0 }
    upsertCfdSnapshot('2026-08-01', metrics, db)

    const rows = listCfdSnapshots(30, db)
    expect(rows).toHaveLength(1)
    expect(rows[0].date).toBe('2026-08-01')
    expect(rows[0].planned).toBe(5)
    expect(rows[0].in_progress).toBe(2)
    expect(rows[0].waiting).toBe(1)
    expect(rows[0].done).toBe(10)
  })

  it('overwrites existing row on repeated call for same date (idempotent)', () => {
    const db = getNoaDb()
    upsertCfdSnapshot('2026-08-02', { planned: 3, in_progress: 1, waiting: 0, done: 5, other: 0 }, db)
    upsertCfdSnapshot('2026-08-02', { planned: 4, in_progress: 2, waiting: 1, done: 6, other: 0 }, db)

    const rows = listCfdSnapshots(30, db)
    expect(rows).toHaveLength(1)
    expect(rows[0].planned).toBe(4)
    expect(rows[0].in_progress).toBe(2)
  })
})

describe('listCfdSnapshots', () => {
  it('returns rows ascending by date (oldest first)', () => {
    const db = getNoaDb()
    upsertCfdSnapshot('2026-08-03', { planned: 1, in_progress: 0, waiting: 0, done: 1, other: 0 }, db)
    upsertCfdSnapshot('2026-08-01', { planned: 2, in_progress: 0, waiting: 0, done: 2, other: 0 }, db)
    upsertCfdSnapshot('2026-08-02', { planned: 3, in_progress: 0, waiting: 0, done: 3, other: 0 }, db)

    const rows = listCfdSnapshots(30, db)
    expect(rows.map(r => r.date)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03'])
  })

  it('limits to the requested number of most recent days', () => {
    const db = getNoaDb()
    for (let i = 1; i <= 5; i++) {
      upsertCfdSnapshot(`2026-08-0${i}`, { planned: i, in_progress: 0, waiting: 0, done: 0, other: 0 }, db)
    }

    const rows = listCfdSnapshots(3, db)
    expect(rows).toHaveLength(3)
    // most recent 3 days, ascending
    expect(rows[0].date).toBe('2026-08-03')
    expect(rows[2].date).toBe('2026-08-05')
  })
})
