import { describe, it, expect, vi, beforeEach } from 'vitest'

// Verify production wiring: realImpactDeps routes calls through noa-kanban + noa-memory
// (not legacy db.ts). Tests mock at the module level so real DB/git is never hit.

vi.mock('../noa-kanban.js', () => ({
  getCard: vi.fn(),
}))

vi.mock('../noa-memory.js', () => ({
  searchAgentMemories: vi.fn(),
}))

// codetree-db stubs (no real SQLite index needed)
vi.mock('../web/codetree-db.js', () => ({
  queryImporters: vi.fn(() => []),
  queryAllSymbols: vi.fn(() => []),
  getIndexedAtEpoch: vi.fn(() => null),
}))

import { getCard } from '../noa-kanban.js'
import { searchAgentMemories } from '../noa-memory.js'
import { realImpactDeps } from '../web/codetree-impact-io.js'

const mockGetCard = vi.mocked(getCard)
const mockSearch = vi.mocked(searchAgentMemories)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('codetree-impact-io: production wiring uses noa-kanban + noa-memory', () => {
  it('getCard delegate calls noa-kanban getCard with the given id', () => {
    mockGetCard.mockReturnValue({
      id: 'abc123', title: 'Fix the bug', description: 'Details here',
      status: 'in_progress', assignee: 'dave', priority: 'high',
      project: null, parent_id: null, due_date: null, sort_order: 0,
      created_at: 0, updated_at: 0, archived_at: null, dispatched_at: null,
      priority_score: 4, depends_on: null, code: null,
    })
    const deps = realImpactDeps()
    const result = deps.getCard('abc123')
    expect(mockGetCard).toHaveBeenCalledWith('abc123')
    expect(result).toEqual({ title: 'Fix the bug', description: 'Details here' })
  })

  it('getCard returns null when noa-kanban getCard returns undefined', () => {
    mockGetCard.mockReturnValue(undefined)
    const deps = realImpactDeps()
    expect(deps.getCard('missing')).toBeNull()
    expect(mockGetCard).toHaveBeenCalledWith('missing')
  })

  it('searchHotMemory calls noa-memory searchAgentMemories with agent + joined keywords', () => {
    mockSearch.mockReturnValue([
      { id: 1, agent_id: 'dave', category: 'hot', content: 'hot item', keywords: 'kw',
        topic_key: null, access_scope: null, embedding: null, created_at: 0, accessed_at: 0 },
    ])
    const deps = realImpactDeps({ agent: 'dave' })
    const result = deps.searchHotMemory(['alpha', 'beta'])
    expect(mockSearch).toHaveBeenCalledWith('dave', 'alpha beta', 10)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('hot item')
  })

  it('searchHotMemory filters out warm/cold memories', () => {
    mockSearch.mockReturnValue([
      { id: 1, agent_id: 'dave', category: 'hot',  content: 'hot',  keywords: null, topic_key: null, access_scope: null, embedding: null, created_at: 0, accessed_at: 0 },
      { id: 2, agent_id: 'dave', category: 'warm', content: 'warm', keywords: null, topic_key: null, access_scope: null, embedding: null, created_at: 0, accessed_at: 0 },
      { id: 3, agent_id: 'dave', category: 'shared', content: 'shared', keywords: null, topic_key: null, access_scope: null, embedding: null, created_at: 0, accessed_at: 0 },
    ])
    const result = realImpactDeps({ agent: 'dave' }).searchHotMemory(['kw'])
    expect(result.map(r => r.category)).not.toContain('warm')
    expect(result.map(r => r.category)).toContain('hot')
    expect(result.map(r => r.category)).toContain('shared')
  })

  it('searchHotMemory returns empty when no agent provided', () => {
    const result = realImpactDeps().searchHotMemory(['keyword'])
    expect(mockSearch).not.toHaveBeenCalled()
    expect(result).toHaveLength(0)
  })
})
