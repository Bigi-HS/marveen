/**
 * Tests for GET /api/kanban/query -- filter + group-by (DASH-032, 34025179).
 */
import { describe, it, expect } from 'vitest'
import { applyFilter, groupCards, type KanbanCardRow, type QueryFilter } from '../web/routes/kanban-query.js'

function card(over: Partial<KanbanCardRow> = {}): KanbanCardRow {
  return {
    id: 'c1',
    title: 'Card',
    status: 'planned',
    assignee: null,
    priority: 'normal',
    project: null,
    code: null,
    priority_score: null,
    last_moved: null,
    updated_at: 0,
    created_at: 0,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// applyFilter (pure)
// ---------------------------------------------------------------------------
describe('applyFilter', () => {
  it('no filter returns all cards', () => {
    const cards = [card({ id: 'a' }), card({ id: 'b' })]
    expect(applyFilter(cards, {})).toHaveLength(2)
  })

  it('filters by status', () => {
    const cards = [card({ id: 'p', status: 'planned' }), card({ id: 'd', status: 'done' })]
    const result = applyFilter(cards, { statuses: ['planned'] })
    expect(result.map(c => c.id)).toEqual(['p'])
  })

  it('filters by multiple statuses', () => {
    const cards = [
      card({ id: 'p', status: 'planned' }),
      card({ id: 'i', status: 'in_progress' }),
      card({ id: 'd', status: 'done' }),
    ]
    const result = applyFilter(cards, { statuses: ['planned', 'in_progress'] })
    expect(result.map(c => c.id).sort()).toEqual(['i', 'p'])
  })

  it('filters by assignee', () => {
    const cards = [card({ id: 'a', assignee: 'dave' }), card({ id: 'b', assignee: 'marveen' })]
    expect(applyFilter(cards, { assignee: 'dave' }).map(c => c.id)).toEqual(['a'])
  })

  it('filters by project', () => {
    const cards = [card({ id: 'e', project: 'ENG' }), card({ id: 'd', project: 'DASH' })]
    expect(applyFilter(cards, { project: 'ENG' }).map(c => c.id)).toEqual(['e'])
  })

  it('filters by priority', () => {
    const cards = [
      card({ id: 'h', priority: 'high' }),
      card({ id: 'n', priority: 'normal' }),
      card({ id: 'u', priority: 'urgent' }),
    ]
    expect(applyFilter(cards, { priorities: ['high', 'urgent'] }).map(c => c.id).sort()).toEqual(['h', 'u'])
  })

  it('filters by code prefix', () => {
    const cards = [
      card({ id: 'eng', code: 'ENG-001' }),
      card({ id: 'ops', code: 'OPS-042' }),
    ]
    expect(applyFilter(cards, { codePrefix: 'ENG' }).map(c => c.id)).toEqual(['eng'])
  })

  it('combined filters are ANDed', () => {
    const cards = [
      card({ id: 'match', assignee: 'dave', status: 'planned' }),
      card({ id: 'wrong-status', assignee: 'dave', status: 'done' }),
      card({ id: 'wrong-assignee', assignee: 'marveen', status: 'planned' }),
    ]
    const result = applyFilter(cards, { assignee: 'dave', statuses: ['planned'] })
    expect(result.map(c => c.id)).toEqual(['match'])
  })
})

// ---------------------------------------------------------------------------
// groupCards (pure)
// ---------------------------------------------------------------------------
describe('groupCards', () => {
  it('groups by status', () => {
    const cards = [
      card({ id: 'p', status: 'planned' }),
      card({ id: 'd', status: 'done' }),
      card({ id: 'p2', status: 'planned' }),
    ]
    const groups = groupCards(cards, 'status')
    const statusMap = Object.fromEntries(groups.map(g => [g.key, g.cards.length]))
    expect(statusMap['planned']).toBe(2)
    expect(statusMap['done']).toBe(1)
  })

  it('groups by project with null fallback', () => {
    const cards = [
      card({ id: 'e', project: 'ENG' }),
      card({ id: 'n', project: null }),
    ]
    const groups = groupCards(cards, 'project')
    const nonNull = groups.find(g => g.key === 'ENG')!
    const nullGroup = groups.find(g => g.key === null)!
    expect(nonNull.cards).toHaveLength(1)
    expect(nullGroup.label).toBe('(none)')
  })

  it('null keys sort last', () => {
    const cards = [
      card({ id: 'a', assignee: null }),
      card({ id: 'b', assignee: 'dave' }),
    ]
    const groups = groupCards(cards, 'assignee')
    expect(groups[0].key).toBe('dave')
    expect(groups[1].key).toBeNull()
  })
})
