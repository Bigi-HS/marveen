import { describe, it, expect } from 'vitest'
import { applyScopeFilter } from '../noa-memory.js'
import type { NoaMemory } from '../noa-memory.js'

// Build a minimal NoaMemory-shaped row for filter tests (slim schema: no chat_id/sector/salience).
function row(over: Partial<NoaMemory>): NoaMemory {
  return {
    id: 1, topic_key: null, content: '', created_at: 0, accessed_at: 0, agent_id: 'claudia',
    category: 'hot', keywords: null, embedding: null, access_scope: null,
    ...over,
  }
}

describe('applyScopeFilter (PM-AC1/AC3 visibility predicate)', () => {
  it('null requester (operator/admin) sees everything, scoped included', () => {
    const rows = [row({ id: 1, access_scope: null }), row({ id: 2, access_scope: 'claudia' })]
    expect(applyScopeFilter(rows, null).map(m => m.id)).toEqual([1, 2])
  })

  it('an unscoped row is visible to any requester', () => {
    const rows = [row({ id: 1, access_scope: null })]
    expect(applyScopeFilter(rows, 'marveen').map(m => m.id)).toEqual([1])
  })

  it('treats empty-string access_scope as unscoped/public', () => {
    const rows = [row({ id: 1, access_scope: '' })]
    expect(applyScopeFilter(rows, 'marveen').map(m => m.id)).toEqual([1])
  })

  it('a scoped row is returned only to the named requester (owner)', () => {
    const rows = [row({ id: 1, access_scope: 'claudia' })]
    expect(applyScopeFilter(rows, 'claudia').map(m => m.id)).toEqual([1])
  })

  it('a scoped row is hidden from a non-owner requester even if category=shared', () => {
    const rows = [row({ id: 1, access_scope: 'claudia', category: 'shared' })]
    expect(applyScopeFilter(rows, 'marveen')).toEqual([])
  })

  it('splits a mixed result set in one pass (opposing combination)', () => {
    const rows = [
      row({ id: 1, access_scope: null, category: 'shared' }),       // public -> visible
      row({ id: 2, access_scope: 'claudia', category: 'shared' }),  // scoped -> hidden from marveen
    ]
    expect(applyScopeFilter(rows, 'marveen').map(m => m.id)).toEqual([1])
  })

  it('does not mutate the input array', () => {
    const rows = [row({ id: 1, access_scope: 'claudia' })]
    const copy = [...rows]
    applyScopeFilter(rows, 'marveen')
    expect(rows).toEqual(copy)
  })
})
