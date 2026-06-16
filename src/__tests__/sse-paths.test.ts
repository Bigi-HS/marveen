import { describe, it, expect } from 'vitest'
import { isSseStreamPath } from '../web/sse-paths.js'

// Card 7c7ea226: the rate-limit skip (web.ts) and the ?token= auth allowance
// (web.ts) both gate on this predicate -- they must agree on exactly which
// paths are long-lived SSE streams.
describe('isSseStreamPath (card 7c7ea226)', () => {
  it('matches the per-agent pane stream', () => {
    expect(isSseStreamPath('/api/agents/dave/pane/stream')).toBe(true)
    expect(isSseStreamPath('/api/agents/marveen/pane/stream')).toBe(true)
  })

  it('matches the dashboard event bus stream', () => {
    expect(isSseStreamPath('/api/events/stream')).toBe(true)
  })

  it('rejects ordinary API paths', () => {
    expect(isSseStreamPath('/api/kanban')).toBe(false)
    expect(isSseStreamPath('/api/events')).toBe(false)
    expect(isSseStreamPath('/api/events/stream/extra')).toBe(false)
    expect(isSseStreamPath('/api/agents/dave/pane')).toBe(false)
  })
})
