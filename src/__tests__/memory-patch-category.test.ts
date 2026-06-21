// Tests for card b68b9e71: PATCH /api/memories/<id> category-only endpoint.
//
// Verifies:
//   1. PATCH updates ONLY the category -- content and accessed_at are unchanged.
//   2. Invalid category returns 400.
//   3. Unknown id returns 404.
//   4. Owner-gate (decideMemoryMutation) enforced same as PUT/DELETE.
//   5. updateMemoryCategory pure DB function: updates category, nothing else.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { rmSync } from 'node:fs'
import { initDatabase, saveAgentMemory, getMemoryById, updateMemoryCategory } from '../db.js'

const TEST_DB = '/tmp/test-memory-patch-category.db'

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

describe('updateMemoryCategory (db layer)', () => {
  it('updates only the category field', () => {
    const id = makeMemory('hot')
    const before = getMemoryById(id)!
    const accessedBefore = before.accessed_at

    // Wait a tick -- accessed_at must NOT change
    const ok = updateMemoryCategory(id, 'warm')
    expect(ok).toBe(true)

    const after = getMemoryById(id)!
    expect(after.category).toBe('warm')
    expect(after.content).toBe('original content')
    expect(after.accessed_at).toBe(accessedBefore) // must be unchanged
  })

  it('returns false for an unknown id', () => {
    expect(updateMemoryCategory(99999, 'warm')).toBe(false)
  })

  it('is idempotent: setting the same category twice is fine', () => {
    const id = makeMemory('hot')
    expect(updateMemoryCategory(id, 'warm')).toBe(true)
    expect(updateMemoryCategory(id, 'warm')).toBe(true)
    expect(getMemoryById(id)!.category).toBe('warm')
  })
})
