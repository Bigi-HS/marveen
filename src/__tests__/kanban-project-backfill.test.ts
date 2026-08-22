/**
 * CF0D1BFE S1 (project-backfill migration): fold pre-enforcement drifted project
 * VALUES into the canonical 14-prefix taxonomy.
 *
 * #439 made the enum system-enforced on the WRITE path (createCard/updateCard +
 * POST route). But rows that predate enforcement can still carry a non-canonical
 * value -- on the live board `test-metrics` (test-tooling cards) drifted in before
 * the gate closed. This slice adds an idempotent migration that remaps known
 * drifted values to their canonical prefix, mirroring the someday->icebox rename
 * already in applyKanbanMigrations.
 *
 * Scope note: the migration is VALUE-based (a small explicit remap table), never
 * card-id based -- ephemeral hex ids do not belong in permanent migration code.
 * Cards with an UNSET project are a one-off operational cleanup (each needs a
 * human category call) and are NOT touched here; a value the remap does not know
 * is intentionally left as-is (this migration only folds the values it recognises).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import {
  applyKanbanMigrations,
  getCard,
  configureKanban,
  invalidateColumnsCache,
  VALID_PROJECTS,
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
  invalidateColumnsCache()
}

beforeEach(wipe)
afterEach(wipe)

// Seed a row with a raw INSERT so we can plant a pre-enforcement (non-canonical)
// project value that createCard would otherwise reject.
function seedRaw(id: string, project: string | null, status = 'planned'): void {
  const now = Math.floor(Date.now() / 1000)
  getNoaDb()
    .prepare(
      `INSERT INTO kanban_cards
        (id, title, description, status, assignee, priority, project, parent_id,
         due_date, sort_order, created_at, updated_at, priority_score, depends_on)
       VALUES (?, ?, '', ?, NULL, 'normal', ?, NULL, NULL, 0, ?, ?, 6, NULL)`,
    )
    .run(id, `card-${id}`, status, project, now, now)
}

function projectOf(id: string): string | null {
  return getCard(id)?.project ?? null
}

describe('cf0d1bfe S1: project-backfill migration', () => {
  it("remaps the drifted 'test-metrics' value to the canonical ENG prefix", () => {
    seedRaw('tm-1', 'test-metrics')
    applyKanbanMigrations()
    expect(projectOf('tm-1')).toBe('ENG')
  })

  it('remaps every test-metrics card, not just the first', () => {
    seedRaw('tm-a', 'test-metrics')
    seedRaw('tm-b', 'test-metrics', 'in_progress')
    applyKanbanMigrations()
    expect(projectOf('tm-a')).toBe('ENG')
    expect(projectOf('tm-b')).toBe('ENG')
  })

  it('leaves an already-canonical value untouched', () => {
    seedRaw('ok-1', 'OPS')
    applyKanbanMigrations()
    expect(projectOf('ok-1')).toBe('OPS')
  })

  it('is idempotent -- a second run keeps the canonical value and does not throw', () => {
    seedRaw('tm-idem', 'test-metrics')
    applyKanbanMigrations()
    expect(() => applyKanbanMigrations()).not.toThrow()
    expect(projectOf('tm-idem')).toBe('ENG')
  })

  it('does not guess an UNSET project (left for one-off operational cleanup)', () => {
    seedRaw('unset-1', null)
    applyKanbanMigrations()
    expect(projectOf('unset-1')).toBeNull()
  })

  it('does not touch an unknown non-canonical value it has no remap rule for', () => {
    seedRaw('mystery-1', 'not-a-real-bucket')
    applyKanbanMigrations()
    // The migration only folds values it recognises; anything else is left as-is
    // so it stays visible as drift rather than being silently mis-bucketed.
    expect(projectOf('mystery-1')).toBe('not-a-real-bucket')
  })

  it('every value the remap targets is itself a canonical prefix', () => {
    // Guardrail: a remap rule must never point at a non-canonical target.
    seedRaw('tm-guard', 'test-metrics')
    applyKanbanMigrations()
    const result = projectOf('tm-guard')
    expect(result).not.toBeNull()
    expect(VALID_PROJECTS.has(result as string)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// cf0d1bfe enum-widen (Boss TG4599): PA -> ASST rename.
//
// PA is retired from the enum; the assistant/personal-admin cards move to the
// new ASST prefix. Design (A): historical PA-NNN codes stay IMMUTABLE (exactly
// as an ENG->OPS reproject keeps its ENG-NNN code) -- only the project VALUE
// folds. Same VALUE-based, idempotent PROJECT_VALUE_REMAP mechanism as
// test-metrics -> ENG above.
// ---------------------------------------------------------------------------

function codeOf(id: string): string | null {
  const row = getNoaDb().prepare('SELECT code FROM kanban_cards WHERE id = ?').get(id) as
    | { code: string | null }
    | undefined
  return row?.code ?? null
}

describe('cf0d1bfe enum-widen: PA -> ASST rename', () => {
  it('remaps a PA card to the canonical ASST prefix', () => {
    seedRaw('pa-1', 'PA')
    applyKanbanMigrations()
    expect(projectOf('pa-1')).toBe('ASST')
  })

  it('remaps every PA card, not just the first', () => {
    seedRaw('pa-a', 'PA')
    seedRaw('pa-b', 'PA', 'in_progress')
    applyKanbanMigrations()
    expect(projectOf('pa-a')).toBe('ASST')
    expect(projectOf('pa-b')).toBe('ASST')
  })

  it('preserves a historical PA-NNN code as IMMUTABLE while the project folds to ASST', () => {
    seedRaw('pa-coded', 'PA')
    // Simulate the live board: this card already carries a PA-003 code from the
    // S2 backfill. The rename must NOT re-sequence it.
    getNoaDb().prepare("UPDATE kanban_cards SET code = 'PA-003' WHERE id = ?").run('pa-coded')
    applyKanbanMigrations()
    expect(projectOf('pa-coded')).toBe('ASST')
    expect(codeOf('pa-coded')).toBe('PA-003')
  })

  it('is idempotent -- a second run keeps ASST and the historical code', () => {
    seedRaw('pa-idem', 'PA')
    getNoaDb().prepare("UPDATE kanban_cards SET code = 'PA-006' WHERE id = ?").run('pa-idem')
    applyKanbanMigrations()
    expect(() => applyKanbanMigrations()).not.toThrow()
    expect(projectOf('pa-idem')).toBe('ASST')
    expect(codeOf('pa-idem')).toBe('PA-006')
  })

  it('ASST is a canonical enum value the remap can target', () => {
    expect(VALID_PROJECTS.has('ASST')).toBe(true)
    expect(VALID_PROJECTS.has('PA')).toBe(false)
  })
})
