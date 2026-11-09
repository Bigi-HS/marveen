import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ClaudiaTodosScreen } from '@/pages/app/ClaudiaTodosScreen'
import * as apiApp from '@/lib/api-app'
import type { ClaudiaTodosResponse, AppCalendarEvent } from '@/lib/api-app'

vi.mock('@/lib/api-app', async (importOriginal) => {
  const orig = await importOriginal<typeof apiApp>()
  return {
    ...orig,
    fetchClaudiaTodos: vi.fn(),
    fetchCalendarToday: vi.fn(),
    markTodoDone: vi.fn(),
  }
})

const mockFetchTodos = vi.mocked(apiApp.fetchClaudiaTodos)
const mockFetchCal = vi.mocked(apiApp.fetchCalendarToday)
const mockMarkDone = vi.mocked(apiApp.markTodoDone)

const EMPTY_TODOS: ClaudiaTodosResponse = {
  today: [],
  carried: [],
  folyamatban: [],
  doneToday: [],
  capCount: 0,
}

const TODOS: ClaudiaTodosResponse = {
  today: [
    { id: 'a1', title: 'Email küldés Péternek', detail: null, kind: 'task', status: null, done: 0, created_at: 1000 },
    { id: 'a2', title: 'Sprint review előkészítés', detail: 'Slide-ok összeszedése', kind: 'task', status: null, done: 0, created_at: 1001 },
  ],
  carried: [
    { id: 'b1', title: 'Régi feladat átvinni', detail: null, kind: 'task', status: null, done: 0, created_at: 900 },
  ],
  folyamatban: [
    { id: 'c1', title: 'Folyamatban lévő projekt', detail: null, kind: 'progress', status: 'in_progress', done: 0, created_at: 800 },
  ],
  doneToday: [],
  capCount: 2,
}

const EVENTS: AppCalendarEvent[] = [
  { id: 'ev1', summary: 'Csapatmegbeszélés', start: '2026-11-09T10:00:00', end: '2026-11-09T10:30:00', location: null, description: null },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ClaudiaTodosScreen', () => {
  it('shows loading skeleton on initial fetch', () => {
    mockFetchTodos.mockReturnValue(new Promise(() => {}))
    mockFetchCal.mockReturnValue(new Promise(() => {}))
    render(<ClaudiaTodosScreen />)
    expect(screen.getByTestId('claudia-loading')).toBeInTheDocument()
  })

  it('shows empty state when no todos', async () => {
    mockFetchTodos.mockResolvedValue(EMPTY_TODOS)
    mockFetchCal.mockResolvedValue([])
    render(<ClaudiaTodosScreen />)
    await waitFor(() => {
      expect(screen.getByText(/nincs feladat/i)).toBeInTheDocument()
    })
  })

  it('renders today todos', async () => {
    mockFetchTodos.mockResolvedValue(TODOS)
    mockFetchCal.mockResolvedValue([])
    render(<ClaudiaTodosScreen />)
    await waitFor(() => {
      expect(screen.getByText('Email küldés Péternek')).toBeInTheDocument()
      expect(screen.getByText('Sprint review előkészítés')).toBeInTheDocument()
    })
  })

  it('renders carried todos in a separate section', async () => {
    mockFetchTodos.mockResolvedValue(TODOS)
    mockFetchCal.mockResolvedValue([])
    render(<ClaudiaTodosScreen />)
    await waitFor(() => {
      expect(screen.getByText('Régi feladat átvinni')).toBeInTheDocument()
      expect(screen.getByText(/áthozott/i)).toBeInTheDocument()
    })
  })

  it('renders folyamatban todos', async () => {
    mockFetchTodos.mockResolvedValue(TODOS)
    mockFetchCal.mockResolvedValue([])
    render(<ClaudiaTodosScreen />)
    await waitFor(() => {
      expect(screen.getByText('Folyamatban lévő projekt')).toBeInTheDocument()
    })
  })

  it('renders todo detail when present', async () => {
    mockFetchTodos.mockResolvedValue(TODOS)
    mockFetchCal.mockResolvedValue([])
    render(<ClaudiaTodosScreen />)
    await waitFor(() => {
      expect(screen.getByText('Slide-ok összeszedése')).toBeInTheDocument()
    })
  })

  it('renders calendar events', async () => {
    mockFetchTodos.mockResolvedValue(EMPTY_TODOS)
    mockFetchCal.mockResolvedValue(EVENTS)
    render(<ClaudiaTodosScreen />)
    await waitFor(() => {
      expect(screen.getByText('Csapatmegbeszélés')).toBeInTheDocument()
    })
  })

  it('calls markTodoDone when done button clicked', async () => {
    mockFetchTodos.mockResolvedValue(TODOS)
    mockFetchCal.mockResolvedValue([])
    mockMarkDone.mockResolvedValue({ ok: true })
    render(<ClaudiaTodosScreen />)
    await waitFor(() => screen.getByText('Email küldés Péternek'))
    // Find the Kész button that is inside the same li as the target todo
    const title = screen.getByText('Email küldés Péternek')
    const li = title.closest('li')!
    const doneBtn = li.querySelector('button')!
    fireEvent.click(doneBtn)
    await waitFor(() => {
      expect(mockMarkDone).toHaveBeenCalledWith('a1')
    })
  })

  it('shows todo as done after marking', async () => {
    mockFetchTodos.mockResolvedValue(TODOS)
    mockFetchCal.mockResolvedValue([])
    mockMarkDone.mockResolvedValue({ ok: true })
    render(<ClaudiaTodosScreen />)
    await waitFor(() => screen.getByText('Email küldés Péternek'))
    const title = screen.getByText('Email küldés Péternek')
    const li = title.closest('li')!
    const doneBtn = li.querySelector('button')!
    fireEvent.click(doneBtn)
    await waitFor(() => {
      expect(screen.getByText('Email küldés Péternek')).toHaveClass('line-through')
    })
  })

  it('shows fetch error state', async () => {
    mockFetchTodos.mockRejectedValue(new Error('Server error'))
    mockFetchCal.mockResolvedValue([])
    render(<ClaudiaTodosScreen />)
    await waitFor(() => {
      expect(screen.getByText(/hiba/i)).toBeInTheDocument()
    })
  })

  it('markTodoDone failure shows inline error', async () => {
    mockFetchTodos.mockResolvedValue(TODOS)
    mockFetchCal.mockResolvedValue([])
    mockMarkDone.mockRejectedValue(new Error('Network error'))
    render(<ClaudiaTodosScreen />)
    await waitFor(() => screen.getByText('Email küldés Péternek'))
    const doneButtons = screen.getAllByRole('button', { name: /kész/i })
    fireEvent.click(doneButtons[0])
    await waitFor(() => {
      expect(screen.getByText(/hiba/i)).toBeInTheDocument()
    })
  })
})
