// Tests for ShowcaseScreen (card 0eff4b06, Phase 3B).
// TDD: written before implementation.
// Covers: loading state, agent card render, state labels, share panel, error.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ShowcaseScreen } from '@/pages/app/ShowcaseScreen'
import * as apiApp from '@/lib/api-app'
import type { ShowcaseAgentItem } from '@/lib/api-app'

vi.mock('@/lib/api-app', async (importOriginal) => {
  const orig = await importOriginal<typeof apiApp>()
  return {
    ...orig,
    fetchShowcaseAgents: vi.fn(),
    generateShowcaseShareToken: vi.fn(),
  }
})

const mockFetch = vi.mocked(apiApp.fetchShowcaseAgents)
const mockGenerate = vi.mocked(apiApp.generateShowcaseShareToken)

const AGENTS: ShowcaseAgentItem[] = [
  { roleLabel: 'NoA', state: 'idle' },
  { roleLabel: 'Dave', state: 'working' },
  { roleLabel: 'Grace', state: 'stopped' },
  { roleLabel: 'Dr. Stone', state: 'running' },
]

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Loading + error
// ---------------------------------------------------------------------------

describe('ShowcaseScreen loading', () => {
  it('shows loading skeleton while fetching', () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    render(<ShowcaseScreen />)
    expect(screen.getByTestId('showcase-loading')).toBeInTheDocument()
  })

  it('shows error message on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))
    render(<ShowcaseScreen />)
    await waitFor(() => expect(screen.getByTestId('showcase-error')).toBeInTheDocument())
  })
})

// ---------------------------------------------------------------------------
// Agent cards
// ---------------------------------------------------------------------------

describe('ShowcaseScreen agent cards', () => {
  it('renders a card for each agent after load', async () => {
    mockFetch.mockResolvedValue(AGENTS)
    render(<ShowcaseScreen />)
    await waitFor(() => {
      for (const a of AGENTS) {
        expect(screen.getByTestId(`showcase-agent-${a.roleLabel}`)).toBeInTheDocument()
      }
    })
  })

  it('displays roleLabel text, not an internal id', async () => {
    mockFetch.mockResolvedValue(AGENTS)
    render(<ShowcaseScreen />)
    await waitFor(() => screen.getByTestId('showcase-agent-NoA'))
    expect(screen.getByTestId('showcase-agent-NoA')).toHaveTextContent('NoA')
    expect(screen.getByTestId('showcase-agent-Dave')).toHaveTextContent('Dave')
  })

  it('assigns correct data-state attributes', async () => {
    mockFetch.mockResolvedValue(AGENTS)
    render(<ShowcaseScreen />)
    await waitFor(() => screen.getByTestId('showcase-agent-NoA'))
    expect(screen.getByTestId('showcase-agent-NoA')).toHaveAttribute('data-state', 'idle')
    expect(screen.getByTestId('showcase-agent-Dave')).toHaveAttribute('data-state', 'working')
    expect(screen.getByTestId('showcase-agent-Grace')).toHaveAttribute('data-state', 'stopped')
    expect(screen.getByTestId('showcase-agent-Dr. Stone')).toHaveAttribute('data-state', 'running')
  })
})

// ---------------------------------------------------------------------------
// Share panel
// ---------------------------------------------------------------------------

describe('ShowcaseScreen share panel', () => {
  it('renders a generate-token button', async () => {
    mockFetch.mockResolvedValue(AGENTS)
    render(<ShowcaseScreen />)
    await waitFor(() => screen.getByTestId('showcase-generate-btn'))
    expect(screen.getByTestId('showcase-generate-btn')).toBeInTheDocument()
  })

  it('calls generateShowcaseShareToken on button click', async () => {
    mockFetch.mockResolvedValue(AGENTS)
    mockGenerate.mockResolvedValue({ ok: true, token: 'jwt.token.here', jti: 'abc123', expires_at: 9999999999 })
    render(<ShowcaseScreen />)
    await waitFor(() => screen.getByTestId('showcase-generate-btn'))
    fireEvent.click(screen.getByTestId('showcase-generate-btn'))
    await waitFor(() => expect(mockGenerate).toHaveBeenCalledOnce())
  })

  it('shows share URL after token generation', async () => {
    mockFetch.mockResolvedValue(AGENTS)
    mockGenerate.mockResolvedValue({ ok: true, token: 'jwt.token.here', jti: 'abc123', expires_at: 9999999999 })
    render(<ShowcaseScreen />)
    await waitFor(() => screen.getByTestId('showcase-generate-btn'))
    fireEvent.click(screen.getByTestId('showcase-generate-btn'))
    await waitFor(() => expect(screen.getByTestId('showcase-share-url')).toBeInTheDocument())
    expect(screen.getByTestId('showcase-share-url').textContent).toContain('jwt.token.here')
  })

  it('shows embed iframe code after token generation', async () => {
    mockFetch.mockResolvedValue(AGENTS)
    mockGenerate.mockResolvedValue({ ok: true, token: 'jwt.token.here', jti: 'abc123', expires_at: 9999999999 })
    render(<ShowcaseScreen />)
    await waitFor(() => screen.getByTestId('showcase-generate-btn'))
    fireEvent.click(screen.getByTestId('showcase-generate-btn'))
    await waitFor(() => expect(screen.getByTestId('showcase-embed-code')).toBeInTheDocument())
    expect(screen.getByTestId('showcase-embed-code').textContent).toContain('<iframe')
  })

  it('shows error on token generation failure (403)', async () => {
    mockFetch.mockResolvedValue(AGENTS)
    mockGenerate.mockRejectedValue(new Error('POST /api/showcase/token failed: 403'))
    render(<ShowcaseScreen />)
    await waitFor(() => screen.getByTestId('showcase-generate-btn'))
    fireEvent.click(screen.getByTestId('showcase-generate-btn'))
    await waitFor(() => expect(screen.getByTestId('showcase-token-error')).toBeInTheDocument())
  })
})
