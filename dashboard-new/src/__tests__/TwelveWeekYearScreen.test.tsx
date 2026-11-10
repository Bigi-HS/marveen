// Tests for TwelveWeekYearScreen (card 2ecd1c93, Phase 2D).
// TDD: written before implementation.
// Covers: loading, items render, error, empty state.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TwelveWeekYearScreen } from '@/pages/app/TwelveWeekYearScreen'
import * as apiApp from '@/lib/api-app'
import type { MemoryEntry } from '@/lib/api-app'

vi.mock('@/lib/api-app', async (importOriginal) => {
  const orig = await importOriginal<typeof apiApp>()
  return { ...orig, fetchTwelveWeekYearData: vi.fn() }
})

vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: () => ({ connected: false, revisions: {} }),
}))

const mockFetch = vi.mocked(apiApp.fetchTwelveWeekYearData)

const ITEMS: MemoryEntry[] = [
  { id: 1, agent_id: 'gelim', content: 'Sprint goal: build habit system', category: 'cold', keywords: '12wy,goal', created_at: 1794000000, updated_at: 1794000000 },
  { id: 2, agent_id: 'gelim', content: 'Week 3: review progress on sleep routine', category: 'cold', keywords: '12wy,sleep', created_at: 1794100000, updated_at: 1794100000 },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TwelveWeekYearScreen loading', () => {
  it('shows loading state while fetching', () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    render(<TwelveWeekYearScreen />)
    expect(screen.getByTestId('twelveweekear-loading')).toBeInTheDocument()
  })
})

describe('TwelveWeekYearScreen items', () => {
  it('renders items after fetch', async () => {
    mockFetch.mockResolvedValue(ITEMS)
    render(<TwelveWeekYearScreen />)
    await waitFor(() => screen.getByTestId('twelveweekear-items'))
    expect(screen.getByTestId('twelveweekear-item-0')).toBeInTheDocument()
    expect(screen.getByTestId('twelveweekear-item-1')).toBeInTheDocument()
    expect(screen.getByTestId('twelveweekear-item-0').textContent).toContain('Sprint goal: build habit system')
    expect(screen.getByTestId('twelveweekear-item-1').textContent).toContain('Week 3: review progress on sleep routine')
  })
})

describe('TwelveWeekYearScreen error', () => {
  it('shows error state on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))
    render(<TwelveWeekYearScreen />)
    await waitFor(() => expect(screen.getByTestId('twelveweekear-error')).toBeInTheDocument())
  })
})

describe('TwelveWeekYearScreen empty', () => {
  it('shows empty state when items array is empty', async () => {
    mockFetch.mockResolvedValue([])
    render(<TwelveWeekYearScreen />)
    await waitFor(() => expect(screen.getByTestId('twelveweekear-empty')).toBeInTheDocument())
  })
})
