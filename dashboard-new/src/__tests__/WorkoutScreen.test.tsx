import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { WorkoutScreen } from '@/pages/app/WorkoutScreen'
import * as apiApp from '@/lib/api-app'
import type { WorkoutPlan } from '@/lib/api-app'

vi.mock('@/lib/api-app', async (importOriginal) => {
  const orig = await importOriginal<typeof apiApp>()
  return {
    ...orig,
    fetchWorkoutPlan: vi.fn(),
    postWorkoutCheckin: vi.fn(),
  }
})

const mockFetchPlan = vi.mocked(apiApp.fetchWorkoutPlan)
const mockCheckin = vi.mocked(apiApp.postWorkoutCheckin)

const PLAN: WorkoutPlan = {
  date: '2026-11-09',
  exercises: [
    { name: 'Guggolás', sets: 4, reps: 8, weight: 100, unit: 'kg' },
    { name: 'Fekvenyomás', sets: 3, reps: 10, weight: 80, unit: 'kg' },
    { name: 'Húzódzkodás', sets: 3, reps: null, weight: null, unit: null },
  ],
  notes: 'Erő edzés A',
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('WorkoutScreen', () => {
  it('shows loading skeleton on initial fetch', () => {
    mockFetchPlan.mockReturnValue(new Promise(() => {}))
    render(<WorkoutScreen />)
    expect(screen.getByTestId('workout-loading')).toBeInTheDocument()
  })

  it('shows rest day message when plan is null', async () => {
    mockFetchPlan.mockResolvedValue(null)
    render(<WorkoutScreen />)
    await waitFor(() => {
      expect(screen.getByText(/pihenőnap/i)).toBeInTheDocument()
    })
  })

  it('shows rest day message when plan has no exercises', async () => {
    mockFetchPlan.mockResolvedValue({ date: '2026-11-09', exercises: [], notes: null })
    render(<WorkoutScreen />)
    await waitFor(() => {
      expect(screen.getByText(/pihenőnap/i)).toBeInTheDocument()
    })
  })

  it('renders all exercises from plan', async () => {
    mockFetchPlan.mockResolvedValue(PLAN)
    render(<WorkoutScreen />)
    await waitFor(() => {
      expect(screen.getByText('Guggolás')).toBeInTheDocument()
      expect(screen.getByText('Fekvenyomás')).toBeInTheDocument()
      expect(screen.getByText('Húzódzkodás')).toBeInTheDocument()
    })
  })

  it('renders exercise sets × reps for exercises with data', async () => {
    mockFetchPlan.mockResolvedValue(PLAN)
    render(<WorkoutScreen />)
    await waitFor(() => {
      expect(screen.getByText(/4.*8/)).toBeInTheDocument()
    })
  })

  it('shows notes when present', async () => {
    mockFetchPlan.mockResolvedValue(PLAN)
    render(<WorkoutScreen />)
    await waitFor(() => {
      expect(screen.getByText('Erő edzés A')).toBeInTheDocument()
    })
  })

  it('submit button disabled when no exercises checked', async () => {
    mockFetchPlan.mockResolvedValue(PLAN)
    render(<WorkoutScreen />)
    await waitFor(() => screen.getByText('Guggolás'))
    const btn = screen.getByRole('button', { name: /edzés kész/i })
    expect(btn).toBeDisabled()
  })

  it('submit button enabled after checking an exercise', async () => {
    mockFetchPlan.mockResolvedValue(PLAN)
    render(<WorkoutScreen />)
    await waitFor(() => screen.getByText('Guggolás'))
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])
    expect(screen.getByRole('button', { name: /edzés kész/i })).not.toBeDisabled()
  })

  it('toggling checkbox off disables submit again', async () => {
    mockFetchPlan.mockResolvedValue(PLAN)
    render(<WorkoutScreen />)
    await waitFor(() => screen.getByText('Guggolás'))
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])
    fireEvent.click(checkboxes[0])
    expect(screen.getByRole('button', { name: /edzés kész/i })).toBeDisabled()
  })

  it('calls postWorkoutCheckin with checked exercise names on submit', async () => {
    mockFetchPlan.mockResolvedValue(PLAN)
    mockCheckin.mockResolvedValue({ sent: true })
    render(<WorkoutScreen />)
    await waitFor(() => screen.getByText('Guggolás'))
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])
    fireEvent.click(checkboxes[2])
    fireEvent.click(screen.getByRole('button', { name: /edzés kész/i }))
    await waitFor(() => {
      expect(mockCheckin).toHaveBeenCalledOnce()
      const note: string = mockCheckin.mock.calls[0][0]
      expect(note).toContain('Guggolás')
      expect(note).toContain('Húzódzkodás')
      expect(note).not.toContain('Fekvenyomás')
    })
  })

  it('shows success message after submission', async () => {
    mockFetchPlan.mockResolvedValue(PLAN)
    mockCheckin.mockResolvedValue({ sent: true })
    render(<WorkoutScreen />)
    await waitFor(() => screen.getByText('Guggolás'))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: /edzés kész/i }))
    await waitFor(() => {
      expect(screen.getByText(/elküldve/i)).toBeInTheDocument()
    })
  })

  it('shows error message on checkin failure', async () => {
    mockFetchPlan.mockResolvedValue(PLAN)
    mockCheckin.mockRejectedValue(new Error('Network error'))
    render(<WorkoutScreen />)
    await waitFor(() => screen.getByText('Guggolás'))
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: /edzés kész/i }))
    await waitFor(() => {
      expect(screen.getByText(/hiba/i)).toBeInTheDocument()
    })
  })

  it('fetch error shows error state', async () => {
    mockFetchPlan.mockRejectedValue(new Error('Server down'))
    render(<WorkoutScreen />)
    await waitFor(() => {
      expect(screen.getByText(/hiba/i)).toBeInTheDocument()
    })
  })
})
