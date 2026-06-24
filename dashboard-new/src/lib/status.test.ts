import { describe, it, expect } from 'vitest'
import {
  AGENT_STATUS_DOT,
  liveStatusFromHealth,
  agentNeedsAttention,
  KANBAN_COLUMNS,
  PRIORITY_BADGE,
} from './status'

describe('liveStatusFromHealth (AC-F0-4 normalisation)', () => {
  it('maps the health board enum to the dot vocabulary', () => {
    expect(liveStatusFromHealth('active')).toBe('busy')
    expect(liveStatusFromHealth('idle')).toBe('idle')
    expect(liveStatusFromHealth('stopped')).toBe('offline')
    expect(liveStatusFromHealth('stalled')).toBe('error')
  })
})

describe('AGENT_STATUS_DOT (AC-F0-4 colours)', () => {
  it('uses palette tokens: idle=accent, busy=primary, offline/error=neutral, unknown=border', () => {
    expect(AGENT_STATUS_DOT.idle).toBe('bg-accent')
    expect(AGENT_STATUS_DOT.busy).toBe('bg-primary')
    expect(AGENT_STATUS_DOT.offline).toBe('bg-neutral')
    expect(AGENT_STATUS_DOT.error).toBe('bg-neutral')
    expect(AGENT_STATUS_DOT.unknown).toBe('bg-border')
  })

  it('uses no inline hex (palette-token classes only)', () => {
    for (const cls of Object.values(AGENT_STATUS_DOT)) {
      expect(cls).not.toMatch(/#[0-9a-fA-F]{3,6}/)
    }
  })
})

describe('agentNeedsAttention (AC-F0-5)', () => {
  it('flags everything except idle and busy', () => {
    expect(agentNeedsAttention('idle')).toBe(false)
    expect(agentNeedsAttention('busy')).toBe(false)
    expect(agentNeedsAttention('error')).toBe(true)
    expect(agentNeedsAttention('offline')).toBe(true)
    expect(agentNeedsAttention('unknown')).toBe(true)
  })
})

describe('KANBAN_COLUMNS (AC-F0-7)', () => {
  it('is exactly the four columns in display order, excluding someday', () => {
    expect(KANBAN_COLUMNS).toEqual(['planned', 'in_progress', 'waiting', 'done'])
  })
})

describe('PRIORITY_BADGE (AC-F0-8, palette-only)', () => {
  it('defines all four priorities with no inline hex', () => {
    for (const p of ['urgent', 'high', 'normal', 'low'] as const) {
      expect(PRIORITY_BADGE[p]).toBeTruthy()
      expect(PRIORITY_BADGE[p]).not.toMatch(/#[0-9a-fA-F]{3,6}/)
    }
  })

  it('gives urgent the strongest (filled brand-orange) treatment', () => {
    expect(PRIORITY_BADGE.urgent).toContain('bg-primary')
    expect(PRIORITY_BADGE.high).toContain('text-primary')
  })
})
