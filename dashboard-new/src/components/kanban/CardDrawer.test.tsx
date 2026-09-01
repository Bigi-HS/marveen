import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CardDrawer } from './CardDrawer'
import type { KanbanCard } from '@/types/api'

function card(over: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'abc123de-0000-0000-0000-000000000000',
    title: 'Test card',
    description: null,
    status: 'planned',
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
    ...over,
  }
}

describe('CardDrawer (DASH-034, AC-F0-9)', () => {
  it('renders nothing when card is null', () => {
    const { container } = render(<CardDrawer card={null} onClose={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the card title in a dialog', () => {
    render(<CardDrawer card={card({ title: 'Fix the thing' })} onClose={() => {}} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Fix the thing')).toBeInTheDocument()
  })

  it('calls onClose when Bezárás button clicked', () => {
    const close = vi.fn()
    render(<CardDrawer card={card()} onClose={close} />)
    fireEvent.click(screen.getByLabelText('Bezárás'))
    expect(close).toHaveBeenCalledOnce()
  })

  it('calls onClose on Escape key', () => {
    const close = vi.fn()
    render(<CardDrawer card={card()} onClose={close} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('calls onClose when backdrop clicked', () => {
    const close = vi.fn()
    render(<CardDrawer card={card({ title: 'X' })} onClose={close} />)
    // The backdrop div (aria-hidden) is behind the card
    const backdrop = screen.getByRole('dialog').querySelector('[aria-hidden="true"]')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop!)
    expect(close).toHaveBeenCalledOnce()
  })

  it('shows taxonomy code when present', () => {
    render(<CardDrawer card={card({ code: 'ENG-042' })} onClose={() => {}} />)
    expect(screen.getByText('ENG-042')).toBeInTheDocument()
  })

  it('shows the card description', () => {
    render(<CardDrawer card={card({ description: 'Some details here' })} onClose={() => {}} />)
    expect(screen.getByText('Some details here')).toBeInTheDocument()
  })

  it('shows assignee display name (not raw id)', () => {
    render(<CardDrawer card={card({ assignee: 'marveen' })} onClose={() => {}} />)
    expect(screen.getByText('NoA')).toBeInTheDocument()
    expect(screen.queryByText('marveen')).not.toBeInTheDocument()
  })

  it('shows project name', () => {
    render(<CardDrawer card={card({ project: 'DASH' })} onClose={() => {}} />)
    expect(screen.getByText('DASH')).toBeInTheDocument()
  })

  it('shows parent_id (truncated to 8 chars) when set', () => {
    render(<CardDrawer card={card({ parent_id: 'aabbccdd-1111-2222-3333-444444444444' })} onClose={() => {}} />)
    expect(screen.getByText('aabbccdd')).toBeInTheDocument()
  })

  it('shows priority_score when set', () => {
    render(<CardDrawer card={card({ priority_score: 7 })} onClose={() => {}} />)
    expect(screen.getByText('7/10')).toBeInTheDocument()
  })

  it('shows "Lejarva" badge when due_date is in the past and card is active', () => {
    const pastDue = Math.floor(Date.now() / 1000) - 86400 // 1 day ago
    render(<CardDrawer card={card({ due_date: pastDue, status: 'planned' })} onClose={() => {}} />)
    expect(screen.getByText('Lejarva')).toBeInTheDocument()
  })

  it('does NOT show "Lejarva" badge for done cards', () => {
    const pastDue = Math.floor(Date.now() / 1000) - 86400
    render(<CardDrawer card={card({ due_date: pastDue, status: 'done' })} onClose={() => {}} />)
    expect(screen.queryByText('Lejarva')).not.toBeInTheDocument()
  })

  it('shows full card ID in reference section', () => {
    const id = 'abc123de-0000-0000-0000-000000000000'
    render(<CardDrawer card={card({ id })} onClose={() => {}} />)
    expect(screen.getByText(id)).toBeInTheDocument()
  })

  it('contains NO edit/save/delete controls (read-only invariant)', () => {
    render(<CardDrawer card={card()} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: /save|edit|delete|mentés|szerkesztés|törlés/i })).not.toBeInTheDocument()
  })
})
