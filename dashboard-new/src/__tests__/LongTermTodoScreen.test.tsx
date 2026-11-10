// Tests for LongTermTodoScreen (card b9e85b3a, Phase 2E).
// TDD: written before implementation.
// Covers: loading, items render, error, empty state.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { LongTermTodoScreen } from '@/pages/app/LongTermTodoScreen'
import * as apiApp from '@/lib/api-app'
import type { MemoryEntry } from '@/lib/api-app'

vi.mock('@/lib/api-app', async (importOriginal) => {
  const orig = await importOriginal<typeof apiApp>()
  return { ...orig, fetchLongTermTodos: vi.fn() }
})

vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: () => ({ connected: false, revisions: {} }),
}))

const mockFetch = vi.mocked(apiApp.fetchLongTermTodos)

const ITEMS: MemoryEntry[] = [
  { id: 10, agent_id: 'claudia', content: 'Learn Spanish to B2 level by end of 2027', category: 'warm', keywords: 'language,goal', created_at: 1793000000, updated_at: 1793000000 },
  { id: 11, agent_id: 'claudia', content: 'Build passive income stream through content', category: 'warm', keywords: 'finance,content', created_at: 1793100000, updated_at: 1793100000 },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('LongTermTodoScreen loading', () => {
  it('shows loading state while fetching', () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    render(<LongTermTodoScreen />)
    expect(screen.getByTestId('longtermtodos-loading')).toBeInTheDocument()
  })
})

describe('LongTermTodoScreen items', () => {
  it('renders items after fetch', async () => {
    mockFetch.mockResolvedValue(ITEMS)
    render(<LongTermTodoScreen />)
    await waitFor(() => screen.getByTestId('longtermtodos-items'))
    expect(screen.getByTestId('longtermtodos-item-0')).toBeInTheDocument()
    expect(screen.getByTestId('longtermtodos-item-1')).toBeInTheDocument()
    expect(screen.getByTestId('longtermtodos-item-0').textContent).toContain('Learn Spanish to B2 level by end of 2027')
    expect(screen.getByTestId('longtermtodos-item-1').textContent).toContain('Build passive income stream through content')
  })
})

describe('LongTermTodoScreen error', () => {
  it('shows error state on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))
    render(<LongTermTodoScreen />)
    await waitFor(() => expect(screen.getByTestId('longtermtodos-error')).toBeInTheDocument())
  })
})

describe('LongTermTodoScreen empty', () => {
  it('shows empty state when items array is empty', async () => {
    mockFetch.mockResolvedValue([])
    render(<LongTermTodoScreen />)
    await waitFor(() => expect(screen.getByTestId('longtermtodos-empty')).toBeInTheDocument())
  })
})
