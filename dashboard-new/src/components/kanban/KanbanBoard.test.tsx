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
    code: null,
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
    expect(screen.getByText('Tervezett')).toBeInTheDocument()
    expect(screen.getByText('Folyamatban')).toBeInTheDocument()
    expect(screen.getByText('Várakozik')).toBeInTheDocument()
    expect(screen.getByText('Kész')).toBeInTheDocument()
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

    fireEvent.click(within(dialog).getByLabelText('Bezárás'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('hides the priority badge for normal cards, shows it for the rest', () => {
    render(
      <KanbanBoard
        cards={[
          card({ id: 'n', priority: 'normal' }),
          card({ id: 'h', priority: 'high' }),
        ]}
      />,
    )
    expect(screen.queryByText('Normál')).not.toBeInTheDocument()
    expect(screen.getByText('Magas')).toBeInTheDocument()
  })

  it('renders the assignee display name, never the raw agent id', () => {
    render(<KanbanBoard cards={[card({ id: 'a', assignee: 'marveen' })]} />)
    expect(screen.getByText('NoA')).toBeInTheDocument()
    expect(screen.queryByText('marveen')).not.toBeInTheDocument()
  })

  it('shows the taxonomy code on a card chip (Boss-facing reference)', () => {
    render(<KanbanBoard cards={[card({ id: 'a', title: 'Coded', project: 'ENG', code: 'ENG-042' })]} />)
    expect(screen.getByText('ENG-042')).toBeInTheDocument()
  })

  it('toggles to the project-grouped view and back to status', () => {
    render(
      <KanbanBoard
        cards={[
          card({ id: 'a', status: 'planned', project: 'ENG', code: 'ENG-001' }),
          card({ id: 'b', status: 'done', project: 'OPS', code: 'OPS-001' }),
        ]}
      />,
    )
    // default view groups by status
    expect(screen.getByText('Tervezett')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Projekt' }))
    // now grouped by project: project lane headers appear, status headers gone
    expect(screen.getByText('ENG')).toBeInTheDocument()
    expect(screen.getByText('OPS')).toBeInTheDocument()
    expect(screen.queryByText('Tervezett')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Státusz' }))
    expect(screen.getByText('Tervezett')).toBeInTheDocument()
    expect(screen.queryByText('ENG')).not.toBeInTheDocument()
  })
})
