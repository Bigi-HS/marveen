import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { KanbanBoard } from './KanbanBoard'
import type { KanbanCard } from '@/types/api'

function card(over: Partial<KanbanCard>): KanbanCard {
  return {
    id: over.id ?? 'x',
    title: over.title ?? 'Card',
    description: null,
    status: over.status ?? 'planned',
    assignee: null,
    priority: over.priority ?? 'normal',
    project: null,
    parent_id: null,
    due_date: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    dispatched_at: null,
    ...over,
  }
}

describe('KanbanBoard (AC-F0-7..9)', () => {
  it('renders the four columns with per-column counts', () => {
    render(
      <KanbanBoard
        cards={[
          card({ id: 'a', status: 'planned' }),
          card({ id: 'b', status: 'planned' }),
          card({ id: 'c', status: 'done' }),
        ]}
      />,
    )
    expect(screen.getByText('Planned')).toBeInTheDocument()
    expect(screen.getByText('In progress')).toBeInTheDocument()
    expect(screen.getByText('Waiting')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    // planned column count badge = 2
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('opens a read-only detail drawer on card click and closes it', () => {
    render(<KanbanBoard cards={[card({ id: 'card-xyz', title: 'Fix the thing', description: 'details here' })]} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Fix the thing'))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('card-xyz')).toBeInTheDocument()
    expect(within(dialog).getByText('details here')).toBeInTheDocument()
    // read-only: no edit/save/delete controls
    expect(within(dialog).queryByRole('button', { name: /save|edit|delete/i })).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByLabelText('Close'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
