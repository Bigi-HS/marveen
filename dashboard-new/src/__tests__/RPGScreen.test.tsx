// Tests for RPGScreen (card 5138b7c7, Phase 3D).
// TDD: written before implementation.
// Covers: loading, XP bar, level badge, streak, combo, achievements, error.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { RPGScreen } from '@/pages/app/RPGScreen'
import * as apiApp from '@/lib/api-app'
import type { RpgStatsResponse } from '@/lib/api-app'

vi.mock('@/lib/api-app', async (importOriginal) => {
  const orig = await importOriginal<typeof apiApp>()
  return { ...orig, fetchRpgStats: vi.fn() }
})

// SSE hook: return stable revisions so tests don't trigger spurious refetches
vi.mock('@/hooks/useEventStream', () => ({
  useEventStream: () => ({ connected: false, revisions: {} }),
}))

const mockFetch = vi.mocked(apiApp.fetchRpgStats)

const STATS: RpgStatsResponse = {
  totalXp: 350,
  level: 3,
  xpInLevel: 50,
  xpForNextLevel: 300,
  streak: 5,
  combo: 2,
  today: '2026-11-10',
  recentAchievements: [
    { id: 'streak-3', title: '3 napos streak', unlocked_at: 1794200000 },
    { id: 'first-xp',  title: 'Első XP',       unlocked_at: 1794100000 },
  ],
  sourceBreakdown: {
    workout_checkin: 150,
    kanban_done:     125,
    daily_log:        75,
  },
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Loading + error
// ---------------------------------------------------------------------------

describe('RPGScreen loading', () => {
  it('shows loading skeleton while fetching', () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    render(<RPGScreen />)
    expect(screen.getByTestId('rpg-loading')).toBeInTheDocument()
  })

  it('shows error message on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))
    render(<RPGScreen />)
    await waitFor(() => expect(screen.getByTestId('rpg-error')).toBeInTheDocument())
  })
})

// ---------------------------------------------------------------------------
// Level badge
// ---------------------------------------------------------------------------

describe('RPGScreen level badge', () => {
  it('shows current level number', async () => {
    mockFetch.mockResolvedValue(STATS)
    render(<RPGScreen />)
    await waitFor(() => screen.getByTestId('rpg-level-badge'))
    expect(screen.getByTestId('rpg-level-badge')).toHaveTextContent('3')
  })

  it('shows total XP value', async () => {
    mockFetch.mockResolvedValue(STATS)
    render(<RPGScreen />)
    await waitFor(() => screen.getByTestId('rpg-total-xp'))
    expect(screen.getByTestId('rpg-total-xp')).toHaveTextContent('350')
  })
})

// ---------------------------------------------------------------------------
// XP progress bar
// ---------------------------------------------------------------------------

describe('RPGScreen XP bar', () => {
  it('renders XP progress bar element', async () => {
    mockFetch.mockResolvedValue(STATS)
    render(<RPGScreen />)
    await waitFor(() => screen.getByTestId('rpg-xp-bar'))
    expect(screen.getByTestId('rpg-xp-bar')).toBeInTheDocument()
  })

  it('XP bar fill width reflects xpInLevel / xpForNextLevel', async () => {
    mockFetch.mockResolvedValue(STATS)
    render(<RPGScreen />)
    await waitFor(() => screen.getByTestId('rpg-xp-bar-fill'))
    const fill = screen.getByTestId('rpg-xp-bar-fill')
    // 50/300 ≈ 16.67%
    const width = fill.style.width
    expect(parseFloat(width)).toBeGreaterThan(16)
    expect(parseFloat(width)).toBeLessThan(18)
  })

  it('shows xpInLevel and xpForNextLevel as text', async () => {
    mockFetch.mockResolvedValue(STATS)
    render(<RPGScreen />)
    await waitFor(() => screen.getByTestId('rpg-xp-label'))
    const label = screen.getByTestId('rpg-xp-label').textContent ?? ''
    expect(label).toContain('50')
    expect(label).toContain('300')
  })
})

// ---------------------------------------------------------------------------
// Streak + combo
// ---------------------------------------------------------------------------

describe('RPGScreen streak and combo', () => {
  it('shows streak count', async () => {
    mockFetch.mockResolvedValue(STATS)
    render(<RPGScreen />)
    await waitFor(() => screen.getByTestId('rpg-streak'))
    expect(screen.getByTestId('rpg-streak')).toHaveTextContent('5')
  })

  it('shows combo count', async () => {
    mockFetch.mockResolvedValue(STATS)
    render(<RPGScreen />)
    await waitFor(() => screen.getByTestId('rpg-combo'))
    expect(screen.getByTestId('rpg-combo')).toHaveTextContent('2')
  })
})

// ---------------------------------------------------------------------------
// Source breakdown table
// ---------------------------------------------------------------------------

describe('RPGScreen source breakdown', () => {
  it('renders a source-breakdown table', async () => {
    mockFetch.mockResolvedValue(STATS)
    render(<RPGScreen />)
    await waitFor(() => screen.getByTestId('rpg-source-breakdown'))
    expect(screen.getByTestId('rpg-source-breakdown')).toBeInTheDocument()
  })

  it('shows each source with its XP total', async () => {
    mockFetch.mockResolvedValue(STATS)
    render(<RPGScreen />)
    await waitFor(() => screen.getByTestId('rpg-source-workout_checkin'))
    expect(screen.getByTestId('rpg-source-workout_checkin')).toHaveTextContent('150')
    expect(screen.getByTestId('rpg-source-kanban_done')).toHaveTextContent('125')
    expect(screen.getByTestId('rpg-source-daily_log')).toHaveTextContent('75')
  })
})

// ---------------------------------------------------------------------------
// Recent achievements
// ---------------------------------------------------------------------------

describe('RPGScreen recent achievements', () => {
  it('renders achievements section', async () => {
    mockFetch.mockResolvedValue(STATS)
    render(<RPGScreen />)
    await waitFor(() => screen.getByTestId('rpg-achievements'))
    expect(screen.getByTestId('rpg-achievements')).toBeInTheDocument()
  })

  it('shows achievement titles', async () => {
    mockFetch.mockResolvedValue(STATS)
    render(<RPGScreen />)
    await waitFor(() => screen.getByTestId('rpg-achievements'))
    expect(screen.getByTestId('rpg-achievements').textContent).toContain('3 napos streak')
    expect(screen.getByTestId('rpg-achievements').textContent).toContain('Első XP')
  })

  it('handles empty achievements gracefully', async () => {
    mockFetch.mockResolvedValue({ ...STATS, recentAchievements: [] })
    render(<RPGScreen />)
    await waitFor(() => screen.getByTestId('rpg-achievements'))
    expect(screen.getByTestId('rpg-achievements')).toBeInTheDocument()
  })
})
