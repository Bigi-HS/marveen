import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KanbanCFD, splitPresentRuns, type CfdSeriesPoint } from './KanbanCFD'

const row = (date: string, planned: number, in_progress: number, waiting: number, done: number) =>
  ({ date, planned, in_progress, waiting, done, other: 0 })

const pt = (date: string, present: boolean): CfdSeriesPoint =>
  ({ date, planned: 1, in_progress: 0, waiting: 0, done: 0, other: 0, present })

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

// C7b (card 27c75118): the chart must NOT silently interpolate across a day
// with no snapshot. Given a gap-aware `series`, the bands break into separate
// segments at the gap rather than connecting through it.
describe('splitPresentRuns (C7b gap segmentation)', () => {
  it('returns one run for a fully-present series', () => {
    const runs = splitPresentRuns([pt('2026-08-01', true), pt('2026-08-02', true), pt('2026-08-03', true)])
    expect(runs).toEqual([[0, 1, 2]])
  })

  it('breaks the run at a gap point', () => {
    const runs = splitPresentRuns([pt('2026-08-01', true), pt('2026-08-02', false), pt('2026-08-03', true)])
    expect(runs).toEqual([[0], [2]])
  })

  it('drops leading/trailing gaps and returns [] for all-gap input', () => {
    expect(splitPresentRuns([pt('a', false), pt('b', false)])).toEqual([])
    const runs = splitPresentRuns([pt('a', false), pt('b', true), pt('c', true), pt('d', false)])
    expect(runs).toEqual([[1, 2]])
  })
})

describe('KanbanCFD gap rendering (C7b)', () => {
  it('draws more area segments when a gap splits the series than when contiguous', () => {
    const contiguous: CfdSeriesPoint[] = [
      { date: '2026-08-01', planned: 2, in_progress: 1, waiting: 1, done: 3, other: 0, present: true },
      { date: '2026-08-02', planned: 2, in_progress: 1, waiting: 1, done: 4, other: 0, present: true },
      { date: '2026-08-03', planned: 3, in_progress: 1, waiting: 0, done: 5, other: 0, present: true },
    ]
    const withGap: CfdSeriesPoint[] = [
      { date: '2026-08-01', planned: 2, in_progress: 1, waiting: 1, done: 3, other: 0, present: true },
      { date: '2026-08-02', planned: 0, in_progress: 0, waiting: 0, done: 0, other: 0, present: false },
      { date: '2026-08-03', planned: 3, in_progress: 1, waiting: 0, done: 5, other: 0, present: true },
    ]
    const { container: c1, unmount } = render(<KanbanCFD snapshots={[]} series={contiguous} />)
    const contiguousPaths = c1.querySelectorAll('path').length
    unmount()
    const { container: c2 } = render(<KanbanCFD snapshots={[]} series={withGap} />)
    const gapPaths = c2.querySelectorAll('path').length
    // A gap splits each band into 2 single-point segments -> strictly more paths.
    expect(gapPaths).toBeGreaterThan(contiguousPaths)
  })
})
