import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { CostBoard } from './CostBoard'
import type { CostAgent, CostBoard as CostBoardData } from '@/types/cost'

const NOW = 1_700_000_100_000

function agent(over: Partial<CostAgent> = {}): CostAgent {
  return {
    agent: 'dave',
    totalCalls: 10,
    totalInput: 1000,
    totalOutput: 500,
    totalCacheRead: 4000,
    totalCacheCreation: 200,
    firstSeen: 1_700_000_000,
    lastSeen: 1_700_000_000,
    totalCostUsd: 1.5,
    ...over,
  }
}

function board(over: Partial<CostBoardData> = {}): CostBoardData {
  return { agents: [agent()], lineage: [], unrated: [], ...over }
}

describe('CostBoard (card e230c097 slice 2)', () => {
  it('renders the board total and one row per agent', () => {
    render(
      <CostBoard
        board={board({ agents: [agent({ agent: 'thor', totalCostUsd: 2 }), agent({ agent: 'chad', totalCostUsd: 3 })] })}
        nowMs={NOW}
      />,
    )
    expect(screen.getByText('$5.00')).toBeInTheDocument() // total
    expect(screen.getByText('Thor')).toBeInTheDocument()
    expect(screen.getByText('Chad')).toBeInTheDocument()
  })

  it('orders agents by spend, highest first', () => {
    render(
      <CostBoard
        board={board({ agents: [agent({ agent: 'chad', totalCostUsd: 1 }), agent({ agent: 'thor', totalCostUsd: 9 })] })}
        nowMs={NOW}
      />,
    )
    const rows = screen.getAllByRole('row')
    // rows[0] is the header; first data row should be the top spender (Thor)
    expect(within(rows[1]).getByText('Thor')).toBeInTheDocument()
  })

  it('warns when there are unrated model rows', () => {
    render(<CostBoard board={board({ unrated: [{ agent: 'dave', model: 'mystery', calls: 3, totalTokens: 100 }] })} nowMs={NOW} />)
    expect(screen.getByText(/nem árazott modell-sor/)).toBeInTheDocument()
  })

  it('shows the phantom lineage section when present', () => {
    render(
      <CostBoard
        board={board({ lineage: [{ parent: 'dave', childCalls: 20, childSessions: 2, childCostUsd: 4.2 }] })}
        nowMs={NOW}
      />,
    )
    expect(screen.getByText(/Phantom orchestráció/)).toBeInTheDocument()
    expect(screen.getByText('$4.20')).toBeInTheDocument()
  })

  it('shows an empty state when there are no agents', () => {
    render(<CostBoard board={board({ agents: [] })} nowMs={NOW} />)
    expect(screen.getByText(/Nincs költség-adat/)).toBeInTheDocument()
  })

  it('shows the per-agent spend-rate (burn) column', () => {
    render(
      <CostBoard
        board={board({
          // $6 over a 2-hour window -> $3.00/ó burn.
          agents: [agent({ agent: 'thor', totalCostUsd: 6, firstSeen: 1_700_000_000, lastSeen: 1_700_007_200 })],
        })}
        nowMs={NOW}
      />,
    )
    expect(screen.getByText('Burn/ó')).toBeInTheDocument()
    expect(screen.getByText('$3.00/ó')).toBeInTheDocument()
  })
})
