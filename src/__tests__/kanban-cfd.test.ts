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
    expect(snap).toEqual({ planned: 0, in_progress: 0, waiting: 0, done: 0 })
  })
})

// ---------------------------------------------------------------------------
// upsertCfdSnapshot + listCfdSnapshots
// ---------------------------------------------------------------------------
describe('upsertCfdSnapshot', () => {
  it('inserts a new row for a date', () => {
    const db = getNoaDb()
    const metrics: CfdMetrics = { planned: 5, in_progress: 2, waiting: 1, done: 10 }
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
    upsertCfdSnapshot('2026-08-02', { planned: 3, in_progress: 1, waiting: 0, done: 5 }, db)
    upsertCfdSnapshot('2026-08-02', { planned: 4, in_progress: 2, waiting: 1, done: 6 }, db)

    const rows = listCfdSnapshots(30, db)
    expect(rows).toHaveLength(1)
    expect(rows[0].planned).toBe(4)
    expect(rows[0].in_progress).toBe(2)
  })
})

describe('listCfdSnapshots', () => {
  it('returns rows ascending by date (oldest first)', () => {
    const db = getNoaDb()
    upsertCfdSnapshot('2026-08-03', { planned: 1, in_progress: 0, waiting: 0, done: 1 }, db)
    upsertCfdSnapshot('2026-08-01', { planned: 2, in_progress: 0, waiting: 0, done: 2 }, db)
    upsertCfdSnapshot('2026-08-02', { planned: 3, in_progress: 0, waiting: 0, done: 3 }, db)

    const rows = listCfdSnapshots(30, db)
    expect(rows.map(r => r.date)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03'])
  })

  it('limits to the requested number of most recent days', () => {
    const db = getNoaDb()
    for (let i = 1; i <= 5; i++) {
      upsertCfdSnapshot(`2026-08-0${i}`, { planned: i, in_progress: 0, waiting: 0, done: 0 }, db)
    }

    const rows = listCfdSnapshots(3, db)
    expect(rows).toHaveLength(3)
    // most recent 3 days, ascending
    expect(rows[0].date).toBe('2026-08-03')
    expect(rows[2].date).toBe('2026-08-05')
  })
})
