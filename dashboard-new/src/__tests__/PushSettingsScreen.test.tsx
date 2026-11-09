import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PushSettingsScreen } from '@/pages/app/PushSettingsScreen'
import * as apiApp from '@/lib/api-app'
import type { PushSettings } from '@/lib/api-app'

vi.mock('@/lib/api-app', async (importOriginal) => {
  const orig = await importOriginal<typeof apiApp>()
  return { ...orig, fetchPushSettings: vi.fn(), savePushSettings: vi.fn() }
})

const mockFetch = vi.mocked(apiApp.fetchPushSettings)
const mockSave = vi.mocked(apiApp.savePushSettings)

const DEFAULT_SETTINGS: PushSettings = { workout: true, todo: true, fleet: true, journal: true }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PushSettingsScreen', () => {
  it('shows loading skeleton on initial fetch', () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    render(<PushSettingsScreen />)
    expect(screen.getByTestId('push-settings-loading')).toBeInTheDocument()
  })

  it('renders a toggle for each category after load', async () => {
    mockFetch.mockResolvedValue(DEFAULT_SETTINGS)
    render(<PushSettingsScreen />)
    await waitFor(() => {
      expect(screen.getByTestId('toggle-workout')).toBeInTheDocument()
      expect(screen.getByTestId('toggle-todo')).toBeInTheDocument()
      expect(screen.getByTestId('toggle-fleet')).toBeInTheDocument()
      expect(screen.getByTestId('toggle-journal')).toBeInTheDocument()
    })
  })

  it('renders toggles as checked when enabled', async () => {
    mockFetch.mockResolvedValue(DEFAULT_SETTINGS)
    render(<PushSettingsScreen />)
    await waitFor(() => screen.getByTestId('toggle-workout'))
    expect(screen.getByTestId('toggle-workout')).toBeChecked()
    expect(screen.getByTestId('toggle-fleet')).toBeChecked()
  })

  it('renders toggle as unchecked when disabled', async () => {
    mockFetch.mockResolvedValue({ ...DEFAULT_SETTINGS, workout: false })
    render(<PushSettingsScreen />)
    await waitFor(() => screen.getByTestId('toggle-workout'))
    expect(screen.getByTestId('toggle-workout')).not.toBeChecked()
  })

  it('calls savePushSettings on toggle change', async () => {
    mockFetch.mockResolvedValue(DEFAULT_SETTINGS)
    mockSave.mockResolvedValue({ ...DEFAULT_SETTINGS, workout: false })
    render(<PushSettingsScreen />)
    await waitFor(() => screen.getByTestId('toggle-workout'))
    fireEvent.click(screen.getByTestId('toggle-workout'))
    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledWith({ workout: false })
    })
  })

  it('updates toggle state optimistically before server response', async () => {
    mockFetch.mockResolvedValue(DEFAULT_SETTINGS)
    mockSave.mockReturnValue(new Promise(() => {})) // never resolves
    render(<PushSettingsScreen />)
    await waitFor(() => screen.getByTestId('toggle-workout'))
    fireEvent.click(screen.getByTestId('toggle-workout'))
    // should immediately show unchecked (optimistic)
    expect(screen.getByTestId('toggle-workout')).not.toBeChecked()
  })

  it('rolls back on save error', async () => {
    mockFetch.mockResolvedValue(DEFAULT_SETTINGS)
    mockSave.mockRejectedValue(new Error('Network error'))
    render(<PushSettingsScreen />)
    await waitFor(() => screen.getByTestId('toggle-workout'))
    fireEvent.click(screen.getByTestId('toggle-workout'))
    // after error, should revert to original state
    await waitFor(() => {
      expect(screen.getByTestId('toggle-workout')).toBeChecked()
    })
  })

  it('shows error message on save failure', async () => {
    mockFetch.mockResolvedValue(DEFAULT_SETTINGS)
    mockSave.mockRejectedValue(new Error('Network error'))
    render(<PushSettingsScreen />)
    await waitFor(() => screen.getByTestId('toggle-workout'))
    fireEvent.click(screen.getByTestId('toggle-workout'))
    await waitFor(() => {
      expect(screen.getByText(/mentési hiba/i)).toBeInTheDocument()
    })
  })

  it('shows fetch error state when load fails', async () => {
    mockFetch.mockRejectedValue(new Error('Server down'))
    render(<PushSettingsScreen />)
    await waitFor(() => {
      expect(screen.getByText(/hiba/i)).toBeInTheDocument()
    })
  })
})
