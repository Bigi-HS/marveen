/**
 * CF0D1BFE S2 (card-code auto-sequence): every card carrying a canonical project
 * gets a stable, human-facing `code` of the form `PREFIX-NNN` (zero-pad-3).
 *
 * Design (locked by marveen 2026-07-30, Boss TG4588):
 *   - PERSISTED `code` column, not computed on read.
 *   - PER-PREFIX counter in a dedicated `kanban_code_seq` table -- NOT `MAX(code)`,
 *     so a deleted highest card never has its number reused (the gap stays).
 *   - IMMUTABLE after create: changing a card's project does NOT re-sequence its
 *     code (an ENG-001 that moves to OPS keeps ENG-001). The only mutation allowed
 *     is the FIRST assignment of a code to a card that never had one.
 *   - Backfill assigns codes to pre-existing code-less cards in created_at ASC
 *     order, per prefix, and leaves the counter positioned to continue from there.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import {
  applyKanbanMigrations,
  createCard,
  updateCard,
  deleteCard,
  getCard,
  configureKanban,
  invalidateColumnsCache,
} from '../noa-kanban.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
  configureKanban({ isRunning: () => false, agentNames: [] })
})

function wipe(): void {
  const db = getNoaDb()
  db.prepare('DELETE FROM kanban_comments').run()
  db.prepare('DELETE FROM kanban_cards').run()
  try { db.prepare('DELETE FROM kanban_code_seq').run() } catch { /* table not created yet in red phase */ }
  invalidateColumnsCache()
}

beforeEach(wipe)
afterEach(wipe)

// Raw insert so we can plant a pre-S2 code-less row with a chosen created_at
// (createCard would auto-assign a code, which is exactly what backfill must do
// for the rows that predate this slice).
function seedRaw(id: string, project: string | null, createdAt: number): void {
  getNoaDb()
    .prepare(
      `INSERT INTO kanban_cards
        (id, title, description, status, assignee, priority, project, parent_id,
         due_date, sort_order, created_at, updated_at, priority_score, depends_on, code)
       VALUES (?, ?, '', 'planned', NULL, 'normal', ?, NULL, NULL, 0, ?, ?, 6, NULL, NULL)`,
    )
    .run(id, `card-${id}`, project, createdAt, createdAt)
}

function codeOf(id: string): string | null {
  return getCard(id)?.code ?? null
}

describe('cf0d1bfe S2: card-code auto-sequence on create', () => {
  it('assigns PREFIX-001 to the first card of a prefix', () => {
    const c = createCard({ title: 'first eng', project: 'ENG' })
    expect(c.code).toBe('ENG-001')
  })

  it('increments per prefix independently', () => {
    createCard({ title: 'eng 1', project: 'ENG' })
    const eng2 = createCard({ title: 'eng 2', project: 'ENG' })
    const ops1 = createCard({ title: 'ops 1', project: 'OPS' })
    const eng3 = createCard({ title: 'eng 3', project: 'ENG' })
    expect(eng2.code).toBe('ENG-002')
    expect(ops1.code).toBe('OPS-001')
    expect(eng3.code).toBe('ENG-003')
  })

  it('zero-pads the sequence to three digits', () => {
    const c = createCard({ title: 'pad', project: 'MEM' })
    expect(c.code).toBe('MEM-001')
    expect(c.code).not.toBe('MEM-1')
  })

  it('leaves code NULL when no project is supplied (internal system card)', () => {
    const c = createCard({ title: 'no project' })
    expect(c.code).toBeNull()
  })
})

describe('cf0d1bfe S2: code is immutable after create', () => {
  it('does NOT re-sequence the code when the project changes', () => {
    const c = createCard({ title: 'moves bucket', project: 'ENG' })
    expect(c.code).toBe('ENG-001')
    updateCard(c.id, { project: 'OPS' })
    // Project label follows the change, but the historical code is frozen.
    expect(getCard(c.id)?.project).toBe('OPS')
    expect(codeOf(c.id)).toBe('ENG-001')
  })

  it('assigns a first code when a code-less card gains a project (not a re-sequence)', () => {
    const c = createCard({ title: 'late project' }) // no project -> no code
    expect(c.code).toBeNull()
    updateCard(c.id, { project: 'OPS' })
    expect(codeOf(c.id)).toBe('OPS-001')
  })

  it('keeps other cards updatable without perturbing their code', () => {
    const c = createCard({ title: 'stable', project: 'DASH' })
    updateCard(c.id, { title: 'renamed', priority: 'high' })
    expect(codeOf(c.id)).toBe('DASH-001')
  })
})

describe('cf0d1bfe S2: counter is monotonic across deletes (gap stays)', () => {
  it('never reuses the number of a deleted highest card', () => {
    const a = createCard({ title: 'a', project: 'SEC' })
    const b = createCard({ title: 'b', project: 'SEC' })
    expect(a.code).toBe('SEC-001')
    expect(b.code).toBe('SEC-002')
    deleteCard(b.id)
    const c = createCard({ title: 'c', project: 'SEC' })
    expect(c.code).toBe('SEC-003') // 002 is a permanent gap, not reused
  })
})

describe('cf0d1bfe S2: backfill assigns codes to pre-existing rows', () => {
  it('numbers code-less cards in created_at ASC order, per prefix', () => {
    seedRaw('e-late', 'ENG', 3000)
    seedRaw('e-early', 'ENG', 1000)
    seedRaw('e-mid', 'ENG', 2000)
    applyKanbanMigrations()
    expect(codeOf('e-early')).toBe('ENG-001')
    expect(codeOf('e-mid')).toBe('ENG-002')
    expect(codeOf('e-late')).toBe('ENG-003')
  })

  it('runs an independent sequence for each prefix', () => {
    seedRaw('o-1', 'OPS', 1000)
    seedRaw('m-1', 'MEM', 1500)
    seedRaw('o-2', 'OPS', 2000)
    applyKanbanMigrations()
    expect(codeOf('o-1')).toBe('OPS-001')
    expect(codeOf('o-2')).toBe('OPS-002')
    expect(codeOf('m-1')).toBe('MEM-001')
  })

  it('does not assign a code to a non-canonical drift value', () => {
    seedRaw('drift-1', 'not-a-real-bucket', 1000)
    applyKanbanMigrations()
    expect(codeOf('drift-1')).toBeNull()
  })

  it('does not assign a code to an unset project', () => {
    seedRaw('unset-1', null, 1000)
    applyKanbanMigrations()
    expect(codeOf('unset-1')).toBeNull()
  })

  it('is idempotent -- a second run leaves existing codes unchanged', () => {
    seedRaw('idem-1', 'DND', 1000)
    seedRaw('idem-2', 'DND', 2000)
    applyKanbanMigrations()
    applyKanbanMigrations()
    expect(codeOf('idem-1')).toBe('DND-001')
    expect(codeOf('idem-2')).toBe('DND-002')
  })

  it('positions the counter to continue after the backfilled maximum', () => {
    seedRaw('bf-1', 'RES', 1000)
    seedRaw('bf-2', 'RES', 2000)
    applyKanbanMigrations()
    const fresh = createCard({ title: 'post-backfill', project: 'RES' })
    expect(fresh.code).toBe('RES-003')
  })

  it('folds a drifted value into its prefix and codes it under that prefix', () => {
    // test-metrics -> ENG happens in the same migration; the code must reflect ENG.
    seedRaw('tm-1', 'test-metrics', 1000)
    applyKanbanMigrations()
    expect(getCard('tm-1')?.project).toBe('ENG')
    expect(codeOf('tm-1')).toBe('ENG-001')
  })
})
