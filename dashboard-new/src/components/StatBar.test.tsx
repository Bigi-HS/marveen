import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { StatBar } from './StatBar'
import type { AgentGridItem, KanbanCard, AgentLiveStatus, KanbanStatus } from '@/types/api'

function agent(status: AgentLiveStatus, name: string = status): AgentGridItem {
  return { name, displayName: name, status, lastActiveTs: null, hasAvatar: false, isMain: false }
}

function card(status: KanbanStatus, id: string = status): KanbanCard {
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
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    dispatched_at: null,
    last_moved: null,
    priority_score: null,
  }
}

function statValue(label: string): string {
  // The label caption and its number share a card; read the number from that card.
  const caption = screen.getByText(label)
  const cardEl = caption.closest('div.surface-card') as HTMLElement
  return within(cardEl).getByText(/^\d+$/).textContent ?? ''
}

describe('StatBar (fleet KPI derivations)', () => {
  const agents = [
    agent('idle', 'a'),
    agent('busy', 'b'),
    agent('busy', 'c'),
    agent('offline', 'd'),
    agent('error', 'e'),
  ]
  const cards = [
    card('planned', 'p'),
    card('in_progress', 'i'),
    card('waiting', 'w'),
    card('done', 'done'),
  ]

  it('online = idle + busy', () => {
    render(<StatBar agents={agents} cards={cards} />)
    expect(statValue('Flotta online')).toBe('3')
  })

  it('working = busy only', () => {
    render(<StatBar agents={agents} cards={cards} />)
    expect(statValue('Épp dolgozik')).toBe('2')
  })

  it('attention = offline + error + unknown (not idle/busy)', () => {
    render(<StatBar agents={agents} cards={cards} />)
    expect(statValue('Figyelmet kér')).toBe('2')
  })

  it('open cards exclude done', () => {
    render(<StatBar agents={agents} cards={cards} />)
    expect(statValue('Nyitott kártya')).toBe('3')
  })
})
