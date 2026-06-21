import { describe, it, expect } from 'vitest'
import { filterAgentInProgressCards, markAgentCardsWaiting, OPUS_LIMIT_COMMENT, type KanbanCardSlice, type KanbanDeps } from '../web/opus-fallback-kanban.js'

function makeCard(id: string, assignee: string | null, status: string): KanbanCardSlice {
  return { id, assignee, status } as KanbanCardSlice
}

// ---------------------------------------------------------------------------
// filterAgentInProgressCards
// ---------------------------------------------------------------------------
describe('filterAgentInProgressCards', () => {
  const cards: KanbanCardSlice[] = [
    makeCard('a1', 'dave', 'in_progress'),
    makeCard('a2', 'dave', 'planned'),
    makeCard('a3', 'dave', 'waiting'),
    makeCard('a4', 'radar', 'in_progress'),
    makeCard('a5', null, 'in_progress'),
    makeCard('a6', 'dave', 'in_progress'),
    makeCard('a7', 'dave', 'done'),
  ]

  it('returns only in_progress cards assigned to the given agent', () => {
    const result = filterAgentInProgressCards(cards, 'dave')
    expect(result.map(c => c.id)).toEqual(['a1', 'a6'])
  })

  it('does not include other agents\' in_progress cards', () => {
    const result = filterAgentInProgressCards(cards, 'dave')
    expect(result.every(c => c.assignee === 'dave')).toBe(true)
  })

  it('does not include unassigned in_progress cards', () => {
    const result = filterAgentInProgressCards(cards, 'dave')
    expect(result.every(c => c.assignee !== null)).toBe(true)
  })

  it('returns empty array when agent has no in_progress cards', () => {
    expect(filterAgentInProgressCards(cards, 'thor')).toHaveLength(0)
  })

  it('returns empty array on empty card list', () => {
    expect(filterAgentInProgressCards([], 'dave')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// markAgentCardsWaiting (injectable deps)
// ---------------------------------------------------------------------------
describe('markAgentCardsWaiting', () => {
  function makeDeps(cards: KanbanCardSlice[]): KanbanDeps & { updates: Array<{id: string; status: string}>; comments: Array<{id: string; comment: string}> } {
    const updates: Array<{id: string; status: string}> = []
    const comments: Array<{id: string; comment: string}> = []
    return {
      updates, comments,
      listCards: () => cards,
      updateCard: (id, fields) => updates.push({ id, status: fields.status }),
      addComment: (id, _author, comment) => comments.push({ id, comment }),
    }
  }

  const cards: KanbanCardSlice[] = [
    makeCard('c1', 'dave', 'in_progress'),
    makeCard('c2', 'dave', 'in_progress'),
    makeCard('c3', 'dave', 'planned'),
    makeCard('c4', 'radar', 'in_progress'),
  ]

  it('sets in_progress cards to waiting and adds a comment for each', () => {
    const deps = makeDeps(cards)
    const count = markAgentCardsWaiting('dave', OPUS_LIMIT_COMMENT, deps)
    expect(count).toBe(2)
    expect(deps.updates).toEqual([
      { id: 'c1', status: 'waiting' },
      { id: 'c2', status: 'waiting' },
    ])
    expect(deps.comments.map(c => c.id)).toEqual(['c1', 'c2'])
    expect(deps.comments[0].comment).toBe(OPUS_LIMIT_COMMENT)
  })

  it('does not touch other agents\' cards', () => {
    const deps = makeDeps(cards)
    markAgentCardsWaiting('dave', OPUS_LIMIT_COMMENT, deps)
    expect(deps.updates.every(u => u.id !== 'c4')).toBe(true)
  })

  it('returns 0 and makes no calls when agent has no in_progress cards', () => {
    const deps = makeDeps(cards)
    const count = markAgentCardsWaiting('thor', OPUS_LIMIT_COMMENT, deps)
    expect(count).toBe(0)
    expect(deps.updates).toHaveLength(0)
    expect(deps.comments).toHaveLength(0)
  })

  it('OPUS_LIMIT_COMMENT mentions Opus and Sunday reset', () => {
    expect(OPUS_LIMIT_COMMENT.toLowerCase()).toMatch(/opus/)
    expect(OPUS_LIMIT_COMMENT.toLowerCase()).toMatch(/vasarnap|sunday|reset/)
  })
})
