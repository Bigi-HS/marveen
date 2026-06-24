import { describe, it, expect } from 'vitest'
import { selectNeedsAttention, needsAttentionEmpty } from './needs-attention'
import type { AgentGridItem, KanbanCard } from '@/types/api'

function agent(name: string, status: AgentGridItem['status']): AgentGridItem {
  return { name, displayName: name, status, lastActiveTs: null, hasAvatar: false, isMain: false }
}

function card(over: Partial<KanbanCard>): KanbanCard {
  return {
    id: over.id ?? 'x',
    title: 'card',
    description: null,
    status: 'planned',
    assignee: null,
    priority: 'normal',
    project: null,
    parent_id: null,
    due_date: null,
    created_at: 0,
    updated_at: 0,
    dispatched_at: null,
    ...over,
  }
}

describe('selectNeedsAttention (AC-F0-5)', () => {
  it('keeps only non-idle/non-busy agents', () => {
    const agents = [
      agent('a', 'idle'),
      agent('b', 'busy'),
      agent('c', 'error'),
      agent('d', 'offline'),
      agent('e', 'unknown'),
    ]
    const na = selectNeedsAttention(agents, [])
    expect(na.agents.map((a) => a.name)).toEqual(['c', 'd', 'e'])
  })

  it('keeps waiting/planned cards at urgent/high priority only', () => {
    const cards = [
      card({ id: '1', status: 'waiting', priority: 'urgent' }),
      card({ id: '2', status: 'planned', priority: 'high' }),
      card({ id: '3', status: 'waiting', priority: 'normal' }), // wrong priority
      card({ id: '4', status: 'in_progress', priority: 'urgent' }), // wrong status
      card({ id: '5', status: 'done', priority: 'high' }), // wrong status
    ]
    const na = selectNeedsAttention([], cards)
    expect(na.cards.map((c) => c.id)).toEqual(['1', '2'])
  })

  it('reports empty when nothing qualifies', () => {
    const na = selectNeedsAttention([agent('a', 'idle')], [card({ priority: 'low' })])
    expect(needsAttentionEmpty(na)).toBe(true)
  })

  it('reports non-empty when an agent or a card qualifies', () => {
    expect(needsAttentionEmpty(selectNeedsAttention([agent('a', 'error')], []))).toBe(false)
    expect(
      needsAttentionEmpty(selectNeedsAttention([], [card({ status: 'waiting', priority: 'high' })])),
    ).toBe(false)
  })
})
