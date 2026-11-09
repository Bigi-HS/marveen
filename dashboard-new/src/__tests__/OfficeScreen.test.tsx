import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { OfficeScreen } from '@/pages/app/OfficeScreen'
import * as apiApp from '@/lib/api-app'
import * as useEventStreamModule from '@/hooks/useEventStream'
import type { AgentActivity } from '@/lib/api-app'

vi.mock('@/lib/api-app', async (importOriginal) => {
  const orig = await importOriginal<typeof apiApp>()
  return { ...orig, fetchAgentActivity: vi.fn() }
})

vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: vi.fn(() => ({ connected: true, revisions: { 'agent-status': 0, kanban: 0, message: 0, board: 0, gate: 0, 'hook-event': 0 } })),
}))

const mockFetchActivity = vi.mocked(apiApp.fetchAgentActivity)
const mockUseEventStream = vi.mocked(useEventStreamModule.useEventStream)

const ACTIVITY: AgentActivity[] = [
  { name: 'marveen', isMain: true, running: true, state: 'working', tail: ['tool call…'] },
  { name: 'dave', isMain: false, running: true, state: 'idle', tail: [] },
  { name: 'scout', isMain: false, running: true, state: 'working', tail: ['Searching…'] },
  { name: 'forge', isMain: false, running: false, state: 'stopped', tail: [] },
]

beforeEach(() => {
  vi.clearAllMocks()
  mockUseEventStream.mockReturnValue({
    connected: true,
    revisions: { 'agent-status': 0, kanban: 0, message: 0, board: 0, gate: 0, 'hook-event': 0 },
  })
})

describe('OfficeScreen', () => {
  it('shows loading skeleton on initial fetch', () => {
    mockFetchActivity.mockReturnValue(new Promise(() => {}))
    render(<OfficeScreen />)
    expect(screen.getByTestId('office-loading')).toBeInTheDocument()
  })

  it('renders an icon for each agent after load', async () => {
    mockFetchActivity.mockResolvedValue(ACTIVITY)
    render(<OfficeScreen />)
    await waitFor(() => {
      for (const a of ACTIVITY) {
        expect(screen.getByTestId(`office-agent-${a.name}`)).toBeInTheDocument()
      }
    })
  })

  it('marks working agents with working state', async () => {
    mockFetchActivity.mockResolvedValue(ACTIVITY)
    render(<OfficeScreen />)
    await waitFor(() => screen.getByTestId('office-agent-marveen'))
    expect(screen.getByTestId('office-agent-marveen')).toHaveAttribute('data-state', 'working')
    expect(screen.getByTestId('office-agent-scout')).toHaveAttribute('data-state', 'working')
  })

  it('marks idle agents with idle state', async () => {
    mockFetchActivity.mockResolvedValue(ACTIVITY)
    render(<OfficeScreen />)
    await waitFor(() => screen.getByTestId('office-agent-dave'))
    expect(screen.getByTestId('office-agent-dave')).toHaveAttribute('data-state', 'idle')
  })

  it('marks stopped agents with stopped state', async () => {
    mockFetchActivity.mockResolvedValue(ACTIVITY)
    render(<OfficeScreen />)
    await waitFor(() => screen.getByTestId('office-agent-forge'))
    expect(screen.getByTestId('office-agent-forge')).toHaveAttribute('data-state', 'stopped')
  })

  it('shows working count badge', async () => {
    mockFetchActivity.mockResolvedValue(ACTIVITY)
    render(<OfficeScreen />)
    await waitFor(() => {
      // 2 working agents (marveen + scout)
      expect(screen.getByTestId('office-working-count')).toHaveTextContent('2')
    })
  })

  it('shows last tail line for working agents when available', async () => {
    mockFetchActivity.mockResolvedValue(ACTIVITY)
    render(<OfficeScreen />)
    await waitFor(() => {
      expect(screen.getByText('Searching…')).toBeInTheDocument()
    })
  })

  it('shows SSE connection indicator when connected', async () => {
    mockFetchActivity.mockResolvedValue(ACTIVITY)
    render(<OfficeScreen />)
    await waitFor(() => {
      expect(screen.getByTestId('office-connected')).toBeInTheDocument()
    })
  })

  it('shows disconnected indicator when SSE is offline', async () => {
    mockUseEventStream.mockReturnValue({
      connected: false,
      revisions: { 'agent-status': 0, kanban: 0, message: 0, board: 0, gate: 0, 'hook-event': 0 },
    })
    mockFetchActivity.mockResolvedValue(ACTIVITY)
    render(<OfficeScreen />)
    await waitFor(() => {
      expect(screen.getByTestId('office-disconnected')).toBeInTheDocument()
    })
  })

  it('shows error state when fetch fails', async () => {
    mockFetchActivity.mockRejectedValue(new Error('Network error'))
    render(<OfficeScreen />)
    await waitFor(() => {
      expect(screen.getByText(/hiba/i)).toBeInTheDocument()
    })
  })

  it('shows empty state when no agents returned', async () => {
    mockFetchActivity.mockResolvedValue([])
    render(<OfficeScreen />)
    await waitFor(() => {
      expect(screen.getByText(/nincs aktív ágens/i)).toBeInTheDocument()
    })
  })
})
