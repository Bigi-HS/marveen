import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import {
  createCard,
  updateCard,
  getCard,
  applyKanbanMigrations,
  CARD_CATEGORIES,
  isValidCategory,
  cardCode,
  InvalidCategoryError,
} from '../noa-kanban.js'

// Card cf0d1bfe: canonical category taxonomy, system-enforced. The stored owner
// stays the hex id; a category prefix yields the display code KAT-<hex-id>.
// Core rule (marveen HARD AC): CREATE is strict on the enum, UPDATE is graceful
// (a category-less update of a legacy card must NOT be rejected, so the 290
// pre-backfill cards keep updating).

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
  applyKanbanMigrations()
})

beforeEach(() => {
  getNoaDb().exec('DELETE FROM kanban_cards')
})

describe('canonical category enum', () => {
  it('accepts every canonical category (standalone + CONT-family)', () => {
    for (const c of CARD_CATEGORIES) expect(isValidCategory(c)).toBe(true)
    // spot-check the Boss-GO set incl. the CONT family and the CV correction
    for (const c of ['DASH', 'CORE', 'CV', 'CONT', 'BIGI', 'DL', 'DUB', 'DISC']) {
      expect(isValidCategory(c)).toBe(true)
    }
  })

  it('rejects anything outside the enum (incl. the retired CARE + wrong case)', () => {
    for (const c of ['CARE', 'xyz', 'dash', 'Cont', '', 'FOO']) {
      expect(isValidCategory(c)).toBe(false)
    }
  })
})

describe('cardCode (KAT-<hex-id> display code)', () => {
  it('prefixes the category to the unchanged hex id', () => {
    expect(cardCode('DASH', '06a63515')).toBe('DASH-06a63515')
    expect(cardCode('CONT', 'deadbeef')).toBe('CONT-deadbeef')
  })
  it('returns null when the card has no category yet (legacy/pre-backfill)', () => {
    expect(cardCode(null, '06a63515')).toBeNull()
  })
})

describe('createCard category enforcement (strict on value)', () => {
  it('persists a valid category and derives the code', () => {
    const card = createCard({ id: 'cat00001', title: 'x', category: 'DASH' })
    expect(card.category).toBe('DASH')
    expect(cardCode(card.category, card.id)).toBe('DASH-cat00001')
    expect(getCard('cat00001')!.category).toBe('DASH')
  })

  it('throws InvalidCategoryError for an out-of-enum category', () => {
    expect(() => createCard({ id: 'cat00002', title: 'x', category: 'CARE' })).toThrow(InvalidCategoryError)
  })

  it('allows an absent category at the core layer (route enforces presence; internal creates stay null)', () => {
    const card = createCard({ id: 'cat00003', title: 'x' })
    expect(card.category).toBeNull()
  })
})

describe('updateCard category (graceful on absence -- marveen HARD AC)', () => {
  it('updates a category-less legacy card WITHOUT a category, leaving category null and NOT throwing', () => {
    createCard({ id: 'leg00001', title: 'legacy' })
    expect(() => updateCard('leg00001', { title: 'legacy renamed' })).not.toThrow()
    const card = getCard('leg00001')!
    expect(card.title).toBe('legacy renamed')
    expect(card.category).toBeNull()
  })

  it('throws InvalidCategoryError when an update sets an out-of-enum category', () => {
    createCard({ id: 'leg00002', title: 'x' })
    expect(() => updateCard('leg00002', { category: 'CARE' })).toThrow(InvalidCategoryError)
  })

  it('sets a valid category on update and leaves it untouched on a later category-less update', () => {
    createCard({ id: 'leg00003', title: 'x' })
    expect(updateCard('leg00003', { category: 'MEM' })).toBe(true)
    expect(getCard('leg00003')!.category).toBe('MEM')
    // a subsequent update that omits category must preserve it (graceful)
    updateCard('leg00003', { title: 'renamed' })
    expect(getCard('leg00003')!.category).toBe('MEM')
  })
})
