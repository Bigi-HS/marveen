import { describe, it, expect } from 'vitest'
import { applyScopeFilter } from '../db.js'
import type { Memory } from '../db.js'

// Build a minimal Memory-shaped row for filter tests. Only the fields the
// filter reads (access_scope) plus identity fields matter; the rest are
// padded so the object satisfies the Memory type at the boundary.
function row(over: Partial<Memory>): Memory {
  return {
    id: 1, chat_id: 'c', topic_key: null, content: '', sector: 'semantic',
    salience: 1, created_at: 0, accessed_at: 0, agent_id: 'claudia',
    category: 'hot', auto_generated: 0, keywords: null, embedding: null,
    access_scope: null,
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
