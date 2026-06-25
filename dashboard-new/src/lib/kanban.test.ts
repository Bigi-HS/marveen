import { describe, it, expect } from 'vitest'
import { groupCardsByStatus } from './kanban'
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
    parent_id: null,
    due_date: null,
    created_at: 0,
    updated_at: 0,
    dispatched_at: null,
  }
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
