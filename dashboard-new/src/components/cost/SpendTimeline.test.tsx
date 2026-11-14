import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SpendTimeline } from './SpendTimeline'
import type { TimelineBucket } from '@/types/cost'

function tb(over: Partial<TimelineBucket> = {}): TimelineBucket {
  return { bucket: 1_700_000_000, agent: 'dave', calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 1, ...over }
}

describe('SpendTimeline (card e230c097 slice 2)', () => {
  it('shows an empty state when there are no buckets', () => {
    render(<SpendTimeline buckets={[]} bucketMinutes={60} />)
    expect(screen.getByText(/Nincs idősor-adat/)).toBeInTheDocument()
  })

  it('renders the window total and one bar per time bucket', () => {
    render(
      <SpendTimeline
        buckets={[
          tb({ bucket: 1_700_000_000, agent: 'dave', costUsd: 2 }),
          tb({ bucket: 1_700_000_000, agent: 'thor', costUsd: 1 }),
          tb({ bucket: 1_700_003_600, agent: 'dave', costUsd: 1.5 }),
        ]}
        bucketMinutes={60}
      />,
    )
    // Two distinct time buckets -> two bars.
    expect(screen.getAllByRole('img', { name: /költség/i })).toHaveLength(1) // the chart wrapper
    expect(screen.getByTestId('timeline-bars').children).toHaveLength(2)
    // Window total = 2 + 1 + 1.5 = $4.50.
    expect(screen.getByText('$4.50')).toBeInTheDocument()
  })
})
