import { describe, it, expect } from 'vitest'
import { isSseStreamPath } from '../web/sse-paths.js'

// Card 7c7ea226: the rate-limit skip in web.ts gates on this predicate -- the
// two long-lived SSE stream paths must be recognised identically so neither
// counts against the per-IP burst budget. (The legacy ?token= auth allowance
// that also keyed off this predicate was removed in card 32bcf962; auth is now
// the normal cookie/bearer gate.)
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
