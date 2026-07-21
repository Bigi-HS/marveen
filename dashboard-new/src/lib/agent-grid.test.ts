import { describe, it, expect } from 'vitest'
import { mergeAgentStatus } from './agent-grid'
import type { AgentSummary } from '@/types/api'

function summary(over: Partial<AgentSummary>): AgentSummary {
  return {
    name: 'dave',
    displayName: 'Dave',
    description: '',
    model: 'inherit',
    activeModel: null,
    running: true,
    hasAvatar: false,
    status: 'configured',
    contextPercent: null,
    ...over,
  }
}

describe('mergeAgentStatus display-name fallback (Boss rule TG3771)', () => {
  it('keeps a backend display name that differs from the id', () => {
    const [item] = mergeAgentStatus([summary({ name: 'scout', displayName: 'Dr. Stone' })], [])
    expect(item.displayName).toBe('Dr. Stone')
  })

  it('remaps when the backend display name is just the raw id', () => {
    const [item] = mergeAgentStatus([summary({ name: 'marveen', displayName: 'marveen' })], [])
    expect(item.displayName).toBe('NoA')
  })

  it('capitalizes unknown ids instead of showing them raw', () => {
    const [item] = mergeAgentStatus([summary({ name: 'percy', displayName: 'percy' })], [])
    expect(item.displayName).toBe('Percy')
  })
})
