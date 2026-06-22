// Tests for card e163dbf7: PATCH /api/memories/<id> partial update.
//
// The PATCH handler previously persisted ONLY the category column (card
// b68b9e71), so a content update was silently dropped (HTTP ok, no change) --
// applegate's curation edits (#210 canonical text, #187/#188/#189 SUPERSEDED
// prefixes) never landed. patchMemory is the general partial-update primitive:
// it persists any subset of the mutable fields and reports which columns
// changed, while preserving the b68b9e71 staleness invariant (a PATCH is a
// curation edit, not an access, so accessed_at is never bumped).

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { rmSync } from 'node:fs'
import { initDatabase, saveAgentMemory, getMemoryById, patchMemory } from '../db.js'

const TEST_DB = '/tmp/test-memory-patch.db'

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

function makeMemory(category = 'hot'): number {
  return saveAgentMemory('dave', 'original content', category, 'kw1').id
}

beforeEach(() => {
  cleanDb()
  initDatabase(TEST_DB)
})
afterAll(() => cleanDb())

describe('patchMemory (db layer, card e163dbf7)', () => {
  // The reported bug: content updates were dropped entirely.
  it('persists a content update and reports it changed', () => {
    const id = makeMemory()
    const updated = patchMemory(id, { content: 'corrected content' })
    expect(updated).toEqual(['content'])
    expect(getMemoryById(id)!.content).toBe('corrected content')
  })

  it('does NOT bump accessed_at on a content patch (curation, not access)', () => {
    const id = makeMemory()
    const accessedBefore = getMemoryById(id)!.accessed_at
    patchMemory(id, { content: 'corrected content' })
    expect(getMemoryById(id)!.accessed_at).toBe(accessedBefore)
  })

  // The b68b9e71 invariant must survive the consolidation.
  it('updates only the category, leaving content and accessed_at intact', () => {
    const id = makeMemory('hot')
    const before = getMemoryById(id)!
    const updated = patchMemory(id, { category: 'warm' })
    expect(updated).toEqual(['category'])
    const after = getMemoryById(id)!
    expect(after.category).toBe('warm')
    expect(after.content).toBe('original content')
    expect(after.accessed_at).toBe(before.accessed_at)
  })

  it('persists several mutable fields at once and reports each', () => {
    const id = makeMemory('hot')
    const updated = patchMemory(id, { content: 'new', category: 'cold', keywords: 'a b c' })
    expect(updated.sort()).toEqual(['category', 'content', 'keywords'])
    const after = getMemoryById(id)!
    expect(after.content).toBe('new')
    expect(after.category).toBe('cold')
    expect(after.keywords).toBe('a b c')
  })

  it('clears keywords when explicitly set to null', () => {
    const id = makeMemory()
    expect(getMemoryById(id)!.keywords).toBe('kw1')
    const updated = patchMemory(id, { keywords: null })
    expect(updated).toEqual(['keywords'])
    expect(getMemoryById(id)!.keywords).toBeNull()
  })

  it('reassigns ownership via agent_id', () => {
    const id = makeMemory()
    const updated = patchMemory(id, { agentId: 'hibiki' })
    expect(updated).toEqual(['agent_id'])
    expect(getMemoryById(id)!.agent_id).toBe('hibiki')
  })

  it('is a no-op for an empty patch (no columns provided)', () => {
    const id = makeMemory()
    const before = getMemoryById(id)!
    expect(patchMemory(id, {})).toEqual([])
    expect(getMemoryById(id)!).toEqual(before)
  })

  it('returns [] for an unknown id', () => {
    expect(patchMemory(99999, { content: 'x' })).toEqual([])
  })

  it('is idempotent: patching the same content twice is fine', () => {
    const id = makeMemory()
    expect(patchMemory(id, { content: 'twice' })).toEqual(['content'])
    expect(patchMemory(id, { content: 'twice' })).toEqual(['content'])
    expect(getMemoryById(id)!.content).toBe('twice')
  })
})
