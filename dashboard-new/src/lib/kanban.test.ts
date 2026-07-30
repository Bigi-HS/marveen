import { describe, it, expect } from 'vitest'
import { groupCardsByStatus, groupCardsByProject } from './kanban'
import type { KanbanCard } from '@/types/api'

function card(id: string, status: KanbanCard['status']): KanbanCard {
  return {
    id,
    title: id,
    description: null,
    status,
    assignee: null,
    priority: 'normal',
    project: null,
    code: null,
    parent_id: null,
    due_date: null,
    created_at: 0,
    updated_at: 0,
    dispatched_at: null,
  }
}

function pcard(id: string, project: string | null, status: KanbanCard['status'] = 'planned'): KanbanCard {
  return { ...card(id, status), project }
}

describe('groupCardsByStatus (AC-F0-7)', () => {
  it('buckets cards into the four columns', () => {
    const groups = groupCardsByStatus([
      card('a', 'planned'),
      card('b', 'in_progress'),
      card('c', 'waiting'),
      card('d', 'done'),
      card('e', 'planned'),
    ])
    expect(groups.planned.map((c) => c.id)).toEqual(['a', 'e'])
    expect(groups.in_progress.map((c) => c.id)).toEqual(['b'])
    expect(groups.waiting.map((c) => c.id)).toEqual(['c'])
    expect(groups.done.map((c) => c.id)).toEqual(['d'])
  })

  it('drops non-column statuses (someday) from the board', () => {
    const groups = groupCardsByStatus([card('s', 'someday'), card('p', 'planned')])
    expect(groups.planned.map((c) => c.id)).toEqual(['p'])
    const total = groups.planned.length + groups.in_progress.length + groups.waiting.length + groups.done.length
    expect(total).toBe(1)
  })

  it('always returns all four column keys, even when empty', () => {
    const groups = groupCardsByStatus([])
    expect(Object.keys(groups).sort()).toEqual(['done', 'in_progress', 'planned', 'waiting'])
  })
})

describe('groupCardsByProject (cf0d1bfe S3)', () => {
  it('buckets cards under their project, in canonical taxonomy order', () => {
    // Input order is deliberately scrambled; output must follow CARD_PROJECTS order
    // (DASH < OPS < ENG in the canonical list), not insertion order.
    const groups = groupCardsByProject([
      pcard('e1', 'ENG'),
      pcard('o1', 'OPS'),
      pcard('d1', 'DASH'),
      pcard('e2', 'ENG'),
    ])
    expect(groups.map((g) => g.project)).toEqual(['DASH', 'OPS', 'ENG'])
    expect(groups.find((g) => g.project === 'ENG')?.cards.map((c) => c.id)).toEqual(['e1', 'e2'])
  })

  it('omits canonical projects that have no cards', () => {
    const groups = groupCardsByProject([pcard('m1', 'MEM')])
    expect(groups.map((g) => g.project)).toEqual(['MEM'])
  })

  it('drops non-column statuses (someday) so both views show the same card set', () => {
    const groups = groupCardsByProject([pcard('s', 'ENG', 'someday'), pcard('p', 'ENG', 'planned')])
    const eng = groups.find((g) => g.project === 'ENG')
    expect(eng?.cards.map((c) => c.id)).toEqual(['p'])
  })

  it('collects null / non-canonical projects into a single trailing group', () => {
    const groups = groupCardsByProject([
      pcard('e1', 'ENG'),
      pcard('n1', null),
      pcard('x1', 'not-a-real-bucket'),
    ])
    // canonical first, uncategorized last
    expect(groups.map((g) => g.project)).toEqual(['ENG', null])
    expect(groups.find((g) => g.project === null)?.cards.map((c) => c.id)).toEqual(['n1', 'x1'])
  })

  it('returns an empty array for no cards', () => {
    expect(groupCardsByProject([])).toEqual([])
  })
})
