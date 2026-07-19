import { describe, it, expect } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { GateBoard } from './GateBoard'
import type { GateBoardPr } from '@/types/gate'

const NOW = 1_700_000_100_000

function pr(over: Partial<GateBoardPr> = {}): GateBoardPr {
  return {
    pr_number: 100,
    author: 'dave',
    seats: { thor: 'none', dave: 'none', chad: 'none' },
    ci_status: 'none',
    ci_required: false,
    override_active: false,
    chad_reviewed: false,
    merge_ready: false,
    last_activity: 1_700_000_000,
    ...over,
  }
}

describe('GateBoard matrix (card 87c32aa4)', () => {
  it('renders one row per PR with the seat headers', () => {
    render(<GateBoard prs={[pr({ pr_number: 410 }), pr({ pr_number: 409 })]} nowMs={NOW} />)
    expect(screen.getByText('#410')).toBeInTheDocument()
    expect(screen.getByText('#409')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Thor' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Dave' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Chad' })).toBeInTheDocument()
  })

  it('shows each seat verdict with an accessible label', () => {
    render(<GateBoard prs={[pr({ seats: { thor: 'approved', dave: 'blocked', chad: 'none' } })]} nowMs={NOW} />)
    const row = screen.getByText('#100').closest('tr')!
    expect(within(row).getByRole('img', { name: 'Approved' })).toBeInTheDocument()
    expect(within(row).getByRole('img', { name: 'Blocked' })).toBeInTheDocument()
    expect(within(row).getByRole('img', { name: 'Pending' })).toBeInTheDocument()
  })

  it('renders the confident "Merge ready" badge only for a Chad-verified ready PR', () => {
    render(
      <GateBoard
        prs={[pr({ merge_ready: true, chad_reviewed: true, seats: { thor: 'approved', dave: 'approved', chad: 'approved' } })]}
        nowMs={NOW}
      />,
    )
    expect(screen.getByText('Merge ready')).toBeInTheDocument()
  })

  it('renders the cautious "Ready (Chad?)" badge when Chad has not acted', () => {
    render(<GateBoard prs={[pr({ merge_ready: true, chad_reviewed: false })]} nowMs={NOW} />)
    expect(screen.getByText('Ready (Chad?)')).toBeInTheDocument()
    expect(screen.queryByText('Merge ready')).not.toBeInTheDocument()
  })

  it('renders the "Override" badge for an override-forced PR', () => {
    render(<GateBoard prs={[pr({ override_active: true, merge_ready: true })]} nowMs={NOW} />)
    expect(screen.getByText('Override')).toBeInTheDocument()
  })

  it('the "my seats now" filter narrows to PRs awaiting the dave seat', () => {
    const awaitingDave = pr({ pr_number: 201, seats: { thor: 'approved', dave: 'none', chad: 'none' } })
    const daveApproved = pr({ pr_number: 202, seats: { thor: 'none', dave: 'approved', chad: 'none' } })
    render(<GateBoard prs={[awaitingDave, daveApproved]} nowMs={NOW} />)

    // Both visible initially.
    expect(screen.getByText('#201')).toBeInTheDocument()
    expect(screen.getByText('#202')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Az én székeim most/ }))

    expect(screen.getByText('#201')).toBeInTheDocument()
    expect(screen.queryByText('#202')).not.toBeInTheDocument()
  })

  it('shows an empty state when the filter matches nothing', () => {
    render(<GateBoard prs={[pr({ seats: { thor: 'none', dave: 'approved', chad: 'none' } })]} nowMs={NOW} />)
    fireEvent.click(screen.getByRole('button', { name: /Az én székeim most/ }))
    expect(screen.getByText(/Nincs rád váró szék/)).toBeInTheDocument()
  })

  it('shows an empty state when there are no PRs at all', () => {
    render(<GateBoard prs={[]} nowMs={NOW} />)
    expect(screen.getByText(/Nincs nyitott PR a gate-en/)).toBeInTheDocument()
  })
})
