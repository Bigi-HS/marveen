import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KanbanCFD } from './KanbanCFD'

const row = (date: string, planned: number, in_progress: number, waiting: number, done: number) =>
  ({ date, planned, in_progress, waiting, done })

describe('KanbanCFD (card b60d578c)', () => {
  it('shows empty-state when no snapshots', () => {
    render(<KanbanCFD snapshots={[]} />)
    expect(screen.getByText(/nincs adat/i)).toBeInTheDocument()
  })

  it('renders an SVG when snapshots provided', () => {
    render(
      <KanbanCFD snapshots={[
        row('2026-08-24', 5, 2, 1, 10),
        row('2026-08-25', 6, 3, 2, 11),
        row('2026-08-26', 7, 2, 1, 12),
      ]} />,
    )
    expect(screen.getByRole('img', { name: /cumulative flow diagram/i })).toBeInTheDocument()
  })

  it('renders legend entries for all four statuses', () => {
    render(<KanbanCFD snapshots={[row('2026-08-26', 5, 2, 1, 10)]} />)
    expect(screen.getByText('Tervezett')).toBeInTheDocument()
    expect(screen.getByText('Folyamatban')).toBeInTheDocument()
    expect(screen.getByText('Várakozik')).toBeInTheDocument()
    expect(screen.getByText('Kész')).toBeInTheDocument()
  })

  it('shows a single data point without crashing', () => {
    render(<KanbanCFD snapshots={[row('2026-08-26', 3, 1, 0, 5)]} />)
    expect(screen.getByRole('img')).toBeInTheDocument()
  })
})
