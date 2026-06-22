import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { rmSync } from 'node:fs'
import { parseScore } from '../web/idea-scoring.js'
import { initDatabase, getDb, createIdea, updateIdea, listIdeas } from '../db.js'

// Card 9c089734: Impact/Effort scoring for the idea box. The CRUD/AI parts of the
// card already shipped; this covers the remaining delta -- the scoring fields.

describe('parseScore (pure validator)', () => {
  it('treats null/undefined/empty as an explicit clear (null)', () => {
    expect(parseScore(undefined)).toEqual({ ok: true, value: null })
    expect(parseScore(null)).toEqual({ ok: true, value: null })
    expect(parseScore('')).toEqual({ ok: true, value: null })
  })

  it('accepts integers 1..5 from number or clean string', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(parseScore(n)).toEqual({ ok: true, value: n })
    expect(parseScore('3')).toEqual({ ok: true, value: 3 })
  })

  it('rejects out-of-range, non-integer, and non-numeric input', () => {
    for (const bad of [0, 6, -1, 2.5, 'abc', '3.5', '', NaN, {}, [], true]) {
      if (bad === '') continue // '' is the clear case, covered above
      expect(parseScore(bad).ok).toBe(false)
    }
  })
})

describe('idea_box scoring columns (db roundtrip)', () => {
  const TEST_DB = '/tmp/test-idea-scoring.db'
  beforeEach(() => { rmSync(TEST_DB, { force: true }); initDatabase(TEST_DB) })
  afterAll(() => rmSync(TEST_DB, { force: true }))

  it('has impact + effort columns', () => {
    const cols = (getDb().prepare("PRAGMA table_info(idea_box)").all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('impact')
    expect(cols).toContain('effort')
  })

  it('defaults impact/effort to null when omitted', () => {
    createIdea({ id: 'i1', title: 'Unscored', description: null, category: 'Egyéb', status: 'new', source: 'test', kanban_id: null })
    const row = listIdeas().find(i => i.id === 'i1')!
    expect(row.impact).toBeNull()
    expect(row.effort).toBeNull()
  })

  it('persists impact/effort on create', () => {
    createIdea({ id: 'i2', title: 'Scored', description: null, category: 'Egyéb', status: 'new', source: 'test', kanban_id: null, impact: 5, effort: 2 })
    const row = listIdeas().find(i => i.id === 'i2')!
    expect(row.impact).toBe(5)
    expect(row.effort).toBe(2)
  })

  it('patches impact/effort on update, leaving others untouched', () => {
    createIdea({ id: 'i3', title: 'Patch me', description: null, category: 'Egyéb', status: 'new', source: 'test', kanban_id: null, impact: 1, effort: 1 })
    expect(updateIdea('i3', { impact: 4 })).toBe(true)
    const row = listIdeas().find(i => i.id === 'i3')!
    expect(row.impact).toBe(4)
    expect(row.effort).toBe(1) // untouched
  })

  it('clears a score when patched with null', () => {
    createIdea({ id: 'i4', title: 'Clear me', description: null, category: 'Egyéb', status: 'new', source: 'test', kanban_id: null, impact: 3, effort: 3 })
    expect(updateIdea('i4', { effort: null })).toBe(true)
    const row = listIdeas().find(i => i.id === 'i4')!
    expect(row.effort).toBeNull()
    expect(row.impact).toBe(3)
  })
})
