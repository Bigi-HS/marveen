/**
 * CF0D1BFE (validation slice): canonical project-enum enforcement.
 *
 * The existing `project` field on kanban_cards IS the taxonomy bucket -- all 291
 * live cards are already classified into exactly 14 canonical prefixes. This slice
 * makes that enum system-enforced: createCard/updateCard reject a non-canonical
 * project VALUE, and the POST /api/kanban route additionally requires it to be
 * PRESENT. No new column, no card_code (that is a separate slice).
 *
 * Canonical enum (14, = the live distinct project set, zero non-canonical on board):
 *   DASH CORE MEM OPS ENG CONT SEC PA EDU WELL DEC RES DND BUCC
 *
 * BIGI / DL / DUB / DISC are NOT standalone codes -- they fold into CONT
 * (content collector), so as a project value they are rejected.
 *
 * Grace invariants:
 *   - core createCard/updateCard validate a project only when one is SUPPLIED
 *     (non-undefined). Absence (undefined) never throws -> protects internal
 *     system-card callers and partial PUT updates from the dashboard.
 *   - presence is a ROUTE policy (POST requires it), not a core-layer one.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import {
  createCard,
  updateCard,
  getCard,
  archiveCard,
  configureKanban,
  invalidateColumnsCache,
  CARD_PROJECTS,
  VALID_PROJECTS,
  InvalidProjectError,
  normalizeProject,
  assertProjectPresent,
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
  db.prepare('DELETE FROM agent_messages').run()
  invalidateColumnsCache()
}

beforeEach(wipe)
afterEach(wipe)

// cf0d1bfe enum-widen (Boss TG4599): 14 -> 27 canonical prefixes. PA retired
// (folded to ASST via PROJECT_VALUE_REMAP); 14 new granular codes added, incl.
// the CONT-family (DUB/DL/DISC/BIGI) which are now VALID standalone project
// values (they still fold into the CONT lane on the board, a display concern).
const CANONICAL = [
  'AGENT', 'ASST', 'BIGI', 'BUCC', 'CONT', 'CORE', 'CV', 'DASH', 'DEC',
  'DISC', 'DL', 'DND', 'DUB', 'EDU', 'ENG', 'FABLE', 'FIX', 'KANB', 'KHOOT',
  'MEM', 'OAUTH', 'OPS', 'RES', 'SEC', 'VOICE', 'WEB', 'WELL',
]

// ---------------------------------------------------------------------------
// Enum shape
// ---------------------------------------------------------------------------

describe('CF0D1BFE enum shape', () => {
  it('CARD_PROJECTS is exactly the 27 canonical prefixes', () => {
    expect([...CARD_PROJECTS].sort()).toEqual([...CANONICAL].sort())
  })

  it('VALID_PROJECTS set mirrors CARD_PROJECTS', () => {
    for (const p of CANONICAL) expect(VALID_PROJECTS.has(p)).toBe(true)
    expect(VALID_PROJECTS.size).toBe(27)
  })

  it('PA is retired from the enum (folded to ASST via remap)', () => {
    expect(VALID_PROJECTS.has('PA')).toBe(false)
    expect(VALID_PROJECTS.has('ASST')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// FALSE-POSITIVE: every canonical value is accepted and stored
// ---------------------------------------------------------------------------

describe('CF0D1BFE false-positive: canonical project values accepted', () => {
  it('all 27 canonical values are accepted by createCard', () => {
    for (const p of CANONICAL) {
      const card = createCard({ title: `Task ${p}`, project: p, suppressIntake: true })
      expect(card.project).toBe(p)
    }
  })

  it('normalizes case: "dash" is accepted and stored as "DASH"', () => {
    const card = createCard({ title: 'lower', project: 'dash', suppressIntake: true })
    expect(card.project).toBe('DASH')
  })

  it('normalizes surrounding whitespace: "  eng  " -> "ENG"', () => {
    const card = createCard({ title: 'ws', project: '  eng  ', suppressIntake: true })
    expect(card.project).toBe('ENG')
  })
})

// ---------------------------------------------------------------------------
// FALSE-NEGATIVE: non-canonical values are rejected with InvalidProjectError
// ---------------------------------------------------------------------------

describe('CF0D1BFE false-negative: non-canonical project values rejected', () => {
  const BAD = [
    'FOO',           // unknown code
    '',              // empty (supplied-but-blank is invalid, distinct from absent)
    'DASHBOARD',     // full name, not the code
    'DASH,ENG',      // CSV multi-token
    'DASH|ENG',      // pipe multi-token
    'DASH ENG',      // space multi-token
    'CONT-BIGI',     // hyphen composite
    'PA',            // retired by the enum-widen (folded to ASST via remap)
    'KB', 'DUBLER',  // still-unknown near-misses
  ]
  for (const bad of BAD) {
    it(`rejects ${JSON.stringify(bad)} with InvalidProjectError`, () => {
      expect(() =>
        createCard({ title: `Bad ${bad}`, project: bad, suppressIntake: true })
      ).toThrow(InvalidProjectError)
    })
  }
})

// ---------------------------------------------------------------------------
// CORE GRACE: absence never throws (protects internal callers + partial PUT)
// ---------------------------------------------------------------------------

describe('CF0D1BFE core grace: absent project is allowed', () => {
  it('createCard without a project succeeds and stores null', () => {
    const card = createCard({ title: 'No project', suppressIntake: true })
    expect(card.project).toBeNull()
  })

  it('createCard with project: null succeeds and stores null', () => {
    const card = createCard({ title: 'Null project', project: null, suppressIntake: true })
    expect(card.project).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// updateCard: validate-when-supplied, graceful on omission
// ---------------------------------------------------------------------------

describe('CF0D1BFE updateCard validation + PUT grace', () => {
  it('omitting project on update never throws and leaves it unchanged', () => {
    const card = createCard({ title: 'Keep', project: 'ENG', suppressIntake: true })
    expect(() => updateCard(card.id, { title: 'Renamed' })).not.toThrow()
    expect(getCard(card.id)!.project).toBe('ENG')
  })

  it('supplying a valid project updates it (normalized)', () => {
    const card = createCard({ title: 'Reproject', project: 'ENG', suppressIntake: true })
    updateCard(card.id, { project: 'sec' })
    expect(getCard(card.id)!.project).toBe('SEC')
  })

  it('supplying a non-canonical project throws InvalidProjectError', () => {
    const card = createCard({ title: 'Bad update', project: 'ENG', suppressIntake: true })
    expect(() => updateCard(card.id, { project: 'PA' })).toThrow(InvalidProjectError)
  })

  it('accepts a newly-canonical CONT-family value (BIGI) on update', () => {
    const card = createCard({ title: 'Reproject to family', project: 'CONT', suppressIntake: true })
    updateCard(card.id, { project: 'bigi' })
    expect(getCard(card.id)!.project).toBe('BIGI')
  })

  it('supplying project: null clears it gracefully (no throw)', () => {
    const card = createCard({ title: 'Clear', project: 'OPS', suppressIntake: true })
    expect(() => updateCard(card.id, { project: null })).not.toThrow()
    expect(getCard(card.id)!.project).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pure helpers (the route uses assertProjectPresent for POST presence)
// ---------------------------------------------------------------------------

describe('normalizeProject helper', () => {
  it('returns null for undefined and null (absence grace)', () => {
    expect(normalizeProject(undefined)).toBeNull()
    expect(normalizeProject(null)).toBeNull()
  })

  it('normalizes and validates a supplied value', () => {
    expect(normalizeProject('DASH')).toBe('DASH')
    expect(normalizeProject('cont')).toBe('CONT')
    expect(normalizeProject('  res ')).toBe('RES')
  })

  it('throws InvalidProjectError on a non-canonical or blank value', () => {
    expect(() => normalizeProject('FOO')).toThrow(InvalidProjectError)
    expect(() => normalizeProject('')).toThrow(InvalidProjectError)
    expect(() => normalizeProject('DASH,ENG')).toThrow(InvalidProjectError)
  })
})

describe('assertProjectPresent helper (route POST policy)', () => {
  it('returns the normalized value when present + canonical', () => {
    expect(assertProjectPresent('DASH')).toBe('DASH')
    expect(assertProjectPresent('cont')).toBe('CONT')
  })

  it('throws InvalidProjectError when absent or blank (presence required)', () => {
    expect(() => assertProjectPresent(undefined)).toThrow(InvalidProjectError)
    expect(() => assertProjectPresent(null)).toThrow(InvalidProjectError)
    expect(() => assertProjectPresent('')).toThrow(InvalidProjectError)
    expect(() => assertProjectPresent('   ')).toThrow(InvalidProjectError)
  })

  it('throws InvalidProjectError on a non-canonical value', () => {
    expect(() => assertProjectPresent('PA')).toThrow(InvalidProjectError)
  })

  it('accepts the CONT-family + ASST values as present + canonical', () => {
    expect(assertProjectPresent('BIGI')).toBe('BIGI')
    expect(assertProjectPresent('dub')).toBe('DUB')
    expect(assertProjectPresent('asst')).toBe('ASST')
  })

  it('error message lists the canonical set', () => {
    try {
      assertProjectPresent('FOO')
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidProjectError)
      expect((err as Error).message).toContain('DASH')
      expect((err as Error).message).toContain('BUCC')
    }
  })
})
