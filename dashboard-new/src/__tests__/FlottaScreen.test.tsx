import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { FlottaScreen } from '@/pages/app/FlottaScreen'
import * as apiApp from '@/lib/api-app'
import type { AgentSummary, KanbanCardSummary } from '@/lib/api-app'

vi.mock('@/lib/api-app', async (importOriginal) => {
  const orig = await importOriginal<typeof apiApp>()
  return {
    ...orig,
    fetchFleetAgents: vi.fn(),
    fetchKanbanOpen: vi.fn(),
  }
})

const mockFetchAgents = vi.mocked(apiApp.fetchFleetAgents)
const mockFetchKanban = vi.mocked(apiApp.fetchKanbanOpen)

const AGENTS: AgentSummary[] = [
  {
    name: 'dave',
    displayName: 'Dave',
    description: 'Lead engineer',
    model: 'claude-sonnet-4-6',
    running: true,
    status: 'configured',
    contextPercent: 42,
    channelHealthy: true,
    hasTelegram: true,
    hasAvatar: true,
  },
  {
    name: 'scout',
    displayName: 'Dr. Stone',
    description: 'Research',
    model: 'claude-haiku-4-5-20251001',
    running: false,
    status: 'configured',
    contextPercent: null,
    channelHealthy: null,
    hasTelegram: true,
    hasAvatar: false,
  },
]

const KANBAN: KanbanCardSummary[] = [
  {
    id: 'card1',
    title: 'Phase 2A Fleet Screen',
    status: 'in_progress',
    priority: 'high',
    assignee: 'dave',
    code: 'ENG-042',
    project: 'APP',
  },
  {
    id: 'card2',
    title: 'Fix memory leak',
    status: 'planned',
    priority: 'normal',
    assignee: null,
    code: 'ENG-043',
    project: 'OPS',
  },
  {
    id: 'card3',
    title: 'Write docs',
    status: 'waiting',
    priority: 'low',
    assignee: 'scout',
    code: 'ENG-044',
    project: 'OPS',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('FlottaScreen', () => {
  it('shows loading skeleton on initial fetch', () => {
    mockFetchAgents.mockReturnValue(new Promise(() => {}))
    mockFetchKanban.mockReturnValue(new Promise(() => {}))
    render(<FlottaScreen />)
    expect(screen.getByTestId('fleet-loading')).toBeInTheDocument()
  })

  it('renders agent display names after load', async () => {
    mockFetchAgents.mockResolvedValue(AGENTS)
    mockFetchKanban.mockResolvedValue(KANBAN)
    render(<FlottaScreen />)
    await waitFor(() => {
      expect(screen.getByText('Dave')).toBeInTheDocument()
      expect(screen.getByText('Dr. Stone')).toBeInTheDocument()
    })
  })

  it('shows running badge for running agents', async () => {
    mockFetchAgents.mockResolvedValue(AGENTS)
    mockFetchKanban.mockResolvedValue(KANBAN)
    render(<FlottaScreen />)
    await waitFor(() => screen.getByText('Dave'))
    expect(screen.getByTestId('agent-running-dave')).toBeInTheDocument()
  })

  it('shows stopped badge for non-running agents', async () => {
    mockFetchAgents.mockResolvedValue(AGENTS)
    mockFetchKanban.mockResolvedValue(KANBAN)
    render(<FlottaScreen />)
    await waitFor(() => screen.getByText('Dr. Stone'))
    expect(screen.getByTestId('agent-stopped-scout')).toBeInTheDocument()
  })

  it('shows context percent for running agents', async () => {
    mockFetchAgents.mockResolvedValue(AGENTS)
    mockFetchKanban.mockResolvedValue(KANBAN)
    render(<FlottaScreen />)
    await waitFor(() => screen.getByText('Dave'))
    expect(screen.getByText(/42\s*%/)).toBeInTheDocument()
  })

  it('shows kanban open card count per status', async () => {
    mockFetchAgents.mockResolvedValue(AGENTS)
    mockFetchKanban.mockResolvedValue(KANBAN)
    render(<FlottaScreen />)
    await waitFor(() => {
      // 1 in_progress, 1 planned, 1 waiting
      expect(screen.getByTestId('kanban-in_progress-count')).toBeInTheDocument()
      expect(screen.getByTestId('kanban-planned-count')).toBeInTheDocument()
      expect(screen.getByTestId('kanban-waiting-count')).toBeInTheDocument()
    })
  })

  it('shows in_progress card titles', async () => {
    mockFetchAgents.mockResolvedValue(AGENTS)
    mockFetchKanban.mockResolvedValue(KANBAN)
    render(<FlottaScreen />)
    await waitFor(() => {
      expect(screen.getByText('Phase 2A Fleet Screen')).toBeInTheDocument()
    })
  })

  it('shows empty agent list message when no agents returned', async () => {
    mockFetchAgents.mockResolvedValue([])
    mockFetchKanban.mockResolvedValue([])
    render(<FlottaScreen />)
    await waitFor(() => {
      expect(screen.getByText(/nincs ágens/i)).toBeInTheDocument()
    })
  })

  it('shows error state when agents fetch fails', async () => {
    mockFetchAgents.mockRejectedValue(new Error('Network error'))
    mockFetchKanban.mockResolvedValue([])
    render(<FlottaScreen />)
    await waitFor(() => {
      expect(screen.getByText(/hiba/i)).toBeInTheDocument()
    })
  })
})
