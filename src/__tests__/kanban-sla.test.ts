/**
 * Tests for GET /api/kanban/sla -- SLA staleness alerts (DASH-033, abb2f275).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import { computeSlaCards, SLA_WARNING_FRACTION, type SlaCard } from '../web/routes/kanban-sla.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

const NOW = 1_800_000_000

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
})

beforeEach(() => {
  getNoaDb().prepare('DELETE FROM kanban_cards').run()
})

function insertCard(over: {
  id?: string; title?: string; status?: string; priority?: string;
  priority_score?: number | null; last_moved?: number | null; updated_at?: number;
} = {}): string {
  const id = over.id ?? 'test-card'
  getNoaDb().prepare(
    `INSERT INTO kanban_cards (id, title, status, priority, priority_score, last_moved, updated_at, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    id,
    over.title ?? 'Test card',
    over.status ?? 'planned',
    over.priority ?? 'normal',
    over.priority_score ?? null,
    over.last_moved ?? null,
    over.updated_at ?? NOW - 86400,
    NOW - 86400,
  )
  return id
}

describe('computeSlaCards', () => {
  it('returns empty when no active cards', () => {
    insertCard({ status: 'done' })
    const cards = computeSlaCards(NOW, getNoaDb())
    expect(cards).toHaveLength(0)
  })

  it('status=unknown when priority_score is null', () => {
    insertCard({ priority_score: null, updated_at: NOW - 100 })
    const cards = computeSlaCards(NOW, getNoaDb())
    expect(cards[0].sla_status).toBe('unknown')
    expect(cards[0].threshold_seconds).toBeNull()
  })

  it('status=ok when card is fresh (below 70% of threshold)', () => {
    // priority_score=5 -> threshold=3days=259200s; 50% = 129600s
    const halfLife = Math.floor(3 * 86400 * 0.5)
    insertCard({ priority_score: 5, updated_at: NOW - halfLife })
    const cards = computeSlaCards(NOW, getNoaDb())
    expect(cards[0].sla_status).toBe('ok')
    expect(cards[0].breach_fraction).not.toBeNull()
    expect(cards[0].breach_fraction!).toBeLessThan(SLA_WARNING_FRACTION)
  })

  it('status=warning when at 80% of threshold', () => {
    // priority_score=5 -> 3 days = 259200s; 80% = 207360s
    const eightyPct = Math.floor(3 * 86400 * 0.8)
    insertCard({ priority_score: 5, updated_at: NOW - eightyPct })
    const cards = computeSlaCards(NOW, getNoaDb())
    expect(cards[0].sla_status).toBe('warning')
    expect(cards[0].breach_fraction!).toBeGreaterThanOrEqual(SLA_WARNING_FRACTION)
    expect(cards[0].breach_fraction!).toBeLessThan(1.0)
  })

  it('status=breach when at or above 100% of threshold', () => {
    // priority_score=5 -> 3 days; 110% = overdue
    const overdue = Math.floor(3 * 86400 * 1.1)
    insertCard({ priority_score: 5, updated_at: NOW - overdue })
    const cards = computeSlaCards(NOW, getNoaDb())
    expect(cards[0].sla_status).toBe('breach')
    expect(cards[0].breach_fraction!).toBeGreaterThanOrEqual(1.0)
  })

  it('uses last_moved when available instead of updated_at', () => {
    // last_moved is recent (10% of 3-day threshold), updated_at is overdue (200%)
    const recentMoved = Math.floor(3 * 86400 * 0.1)
    insertCard({
      priority_score: 5,
      last_moved: NOW - recentMoved,
      updated_at: NOW - 3 * 86400 * 2,
    })
    const cards = computeSlaCards(NOW, getNoaDb())
    expect(cards[0].sla_status).toBe('ok') // last_moved says fresh
  })

  it('summary fields are computed correctly', () => {
    insertCard({ id: 'ok-card', priority_score: 5, updated_at: NOW - 86400 })           // 1d < 3d threshold
    insertCard({ id: 'breach-card', priority_score: 5, updated_at: NOW - 5 * 86400 }) // 5d > 3d threshold
    insertCard({ id: 'unknown-card', priority_score: null, updated_at: NOW - 86400 })

    const cards = computeSlaCards(NOW, getNoaDb())
    const statusMap = Object.fromEntries(cards.map(c => [c.id, c.sla_status]))
    expect(statusMap['ok-card']).toBe('ok')
    expect(statusMap['breach-card']).toBe('breach')
    expect(statusMap['unknown-card']).toBe('unknown')
  })
})
