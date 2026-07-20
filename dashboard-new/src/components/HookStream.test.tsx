import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { HookStream } from './HookStream'
import type { ToolCallEvent } from '@/types/api'

function ev(over: Partial<ToolCallEvent>): ToolCallEvent {
  return {
    id: over.id ?? 1,
    session_id: over.session_id ?? 'sessionABCDEF',
    tool_name: over.tool_name ?? 'Bash',
    input_summary: over.input_summary ?? null,
    success: over.success ?? 1,
    created_at: over.created_at ?? 1_700_000_000,
    ...over,
  }
}

const NOW = 1_700_000_100 * 1000 // 100s after the base event

describe('HookStream (card 229a9000)', () => {
  it('renders an empty-state hint when there are no events', () => {
    render(<HookStream events={[]} nowMs={NOW} />)
    expect(screen.getByText(/nincs friss hook-esemeny/i)).toBeInTheDocument()
  })

  it('lists events newest-first with the tool name', () => {
    render(
      <HookStream
        nowMs={NOW}
        events={[
          ev({ id: 1, tool_name: 'Bash', created_at: 1_700_000_000 }),
          ev({ id: 2, tool_name: 'Edit', created_at: 1_700_000_050 }),
        ]}
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    // newest (Edit @ +50) first
    expect(within(items[0]).getByText('Edit')).toBeInTheDocument()
    expect(within(items[1]).getByText('Bash')).toBeInTheDocument()
  })

  it('marks success vs failure with distinct accessible labels', () => {
    render(
      <HookStream
        nowMs={NOW}
        events={[
          ev({ id: 1, tool_name: 'Bash', success: 1 }),
          ev({ id: 2, tool_name: 'Edit', success: 0 }),
        ]}
      />,
    )
    expect(screen.getByLabelText('success')).toBeInTheDocument()
    expect(screen.getByLabelText('failed')).toBeInTheDocument()
  })

  it('shows a truncated input summary and a short session id', () => {
    render(
      <HookStream
        nowMs={NOW}
        events={[ev({ id: 1, session_id: 'abcdef1234567890', input_summary: 'ls -la /very/long/path' })]}
      />,
    )
    expect(screen.getByText(/ls -la/)).toBeInTheDocument()
    // session id shown compact (first 8 chars)
    expect(screen.getByText('abcdef12')).toBeInTheDocument()
  })
})
