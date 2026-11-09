import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { GelimJournalScreen } from '@/pages/app/GelimJournalScreen'
import * as apiApp from '@/lib/api-app'
import type { JournalEntry } from '@/lib/api-app'

vi.mock('@/lib/api-app', async (importOriginal) => {
  const orig = await importOriginal<typeof apiApp>()
  return {
    ...orig,
    fetchJournalEntries: vi.fn(),
    postJournalEntry: vi.fn(),
  }
})

const mockFetch = vi.mocked(apiApp.fetchJournalEntries)
const mockPost = vi.mocked(apiApp.postJournalEntry)

const ENTRIES: JournalEntry[] = [
  { id: 3, content: 'Produktív nap volt', mood: 'happy', tags: 'munka', createdAt: 1794200000 },
  { id: 2, content: 'Hosszú megbeszélés', mood: null, tags: null, createdAt: 1794100000 },
  { id: 1, content: 'Reggeliztem', mood: 'neutral', tags: 'reggel,étel', createdAt: 1794000000 },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GelimJournalScreen', () => {
  it('shows loading skeleton on initial fetch', () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    render(<GelimJournalScreen />)
    expect(screen.getByTestId('journal-loading')).toBeInTheDocument()
  })

  it('renders entries after fetch', async () => {
    mockFetch.mockResolvedValue(ENTRIES)
    render(<GelimJournalScreen />)
    await waitFor(() => {
      expect(screen.getByText('Produktív nap volt')).toBeInTheDocument()
      expect(screen.getByText('Hosszú megbeszélés')).toBeInTheDocument()
    })
  })

  it('shows mood when present', async () => {
    mockFetch.mockResolvedValue(ENTRIES)
    render(<GelimJournalScreen />)
    await waitFor(() => {
      expect(screen.getByText('happy')).toBeInTheDocument()
    })
  })

  it('shows tags when present', async () => {
    mockFetch.mockResolvedValue(ENTRIES)
    render(<GelimJournalScreen />)
    await waitFor(() => {
      expect(screen.getByText('munka')).toBeInTheDocument()
    })
  })

  it('shows empty state when no entries', async () => {
    mockFetch.mockResolvedValue([])
    render(<GelimJournalScreen />)
    await waitFor(() => {
      expect(screen.getByText(/nincs bejegyzés/i)).toBeInTheDocument()
    })
  })

  it('renders write form with textarea and submit button', async () => {
    mockFetch.mockResolvedValue([])
    render(<GelimJournalScreen />)
    await waitFor(() => screen.getByPlaceholderText(/mi történt/i))
    expect(screen.getByPlaceholderText(/mi történt/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /bejegyzés/i })).toBeInTheDocument()
  })

  it('submit button disabled when textarea empty', async () => {
    mockFetch.mockResolvedValue([])
    render(<GelimJournalScreen />)
    await waitFor(() => screen.getByRole('button', { name: /bejegyzés/i }))
    expect(screen.getByRole('button', { name: /bejegyzés/i })).toBeDisabled()
  })

  it('submit button enabled after typing content', async () => {
    mockFetch.mockResolvedValue([])
    render(<GelimJournalScreen />)
    await waitFor(() => screen.getByPlaceholderText(/mi történt/i))
    fireEvent.change(screen.getByPlaceholderText(/mi történt/i), { target: { value: 'Ma sokat dolgoztam' } })
    expect(screen.getByRole('button', { name: /bejegyzés/i })).not.toBeDisabled()
  })

  it('calls postJournalEntry with content on submit', async () => {
    mockFetch.mockResolvedValueOnce([]).mockResolvedValue([])
    mockPost.mockResolvedValue({ id: 42 })
    render(<GelimJournalScreen />)
    await waitFor(() => screen.getByPlaceholderText(/mi történt/i))
    fireEvent.change(screen.getByPlaceholderText(/mi történt/i), { target: { value: 'Ma sokat dolgoztam' } })
    fireEvent.click(screen.getByRole('button', { name: /bejegyzés/i }))
    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith('Ma sokat dolgoztam', undefined, undefined)
    })
  })

  it('clears textarea and refreshes list after successful post', async () => {
    const refreshedEntries: JournalEntry[] = [
      { id: 42, content: 'Ma sokat dolgoztam', mood: null, tags: null, createdAt: 1794300000 },
    ]
    mockFetch.mockResolvedValueOnce([]).mockResolvedValueOnce(refreshedEntries)
    mockPost.mockResolvedValue({ id: 42 })
    render(<GelimJournalScreen />)
    await waitFor(() => screen.getByPlaceholderText(/mi történt/i))
    fireEvent.change(screen.getByPlaceholderText(/mi történt/i), { target: { value: 'Ma sokat dolgoztam' } })
    fireEvent.click(screen.getByRole('button', { name: /bejegyzés/i }))
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/mi történt/i)).toHaveValue('')
      expect(screen.getByText('Ma sokat dolgoztam')).toBeInTheDocument()
    })
  })

  it('shows error on post failure', async () => {
    mockFetch.mockResolvedValue([])
    mockPost.mockRejectedValue(new Error('Server error'))
    render(<GelimJournalScreen />)
    await waitFor(() => screen.getByPlaceholderText(/mi történt/i))
    fireEvent.change(screen.getByPlaceholderText(/mi történt/i), { target: { value: 'Teszt bejegyzés' } })
    fireEvent.click(screen.getByRole('button', { name: /bejegyzés/i }))
    await waitFor(() => {
      expect(screen.getByText(/hiba/i)).toBeInTheDocument()
    })
  })

  it('shows fetch error state', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))
    render(<GelimJournalScreen />)
    await waitFor(() => {
      expect(screen.getByText(/hiba/i)).toBeInTheDocument()
    })
  })
})
