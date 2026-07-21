import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentChip } from './AgentChip'
import type { AgentGridItem } from '@/types/api'

const NOW = 1_700_000_000_000

function item(over: Partial<AgentGridItem> = {}): AgentGridItem {
  return { name: 'dave', displayName: 'Dave', status: 'idle', lastActiveTs: null, hasAvatar: false, isMain: false, ...over }
}

describe('AgentChip (AC-F0-3)', () => {
  it('shows the display name, status label, and relative last-active', () => {
    render(<AgentChip agent={item({ status: 'busy', lastActiveTs: NOW - 2 * 60_000 })} nowMs={NOW} />)
    expect(screen.getByText('Dave')).toBeInTheDocument()
    expect(screen.getByLabelText('Dolgozik')).toBeInTheDocument()
    expect(screen.getByText('2 perce')).toBeInTheDocument()
  })

  it('renders "Soha" when last-active is null', () => {
    render(<AgentChip agent={item({ lastActiveTs: null })} nowMs={NOW} />)
    expect(screen.getByText('Soha')).toBeInTheDocument()
  })

  it('falls back to initials when there is no avatar', () => {
    render(<AgentChip agent={item({ name: 'scout', hasAvatar: false })} nowMs={NOW} />)
    expect(screen.getByText('SC')).toBeInTheDocument()
  })
})
