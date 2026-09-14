import { describe, it, expect } from 'vitest'
import { ensureSessionEndMarkerHook } from '../web/agent-scaffold.js'

// Template entry exactly as it ships (placeholder unresolved; the merge helper
// only inspects the command substring, so literal {{PROJECT_ROOT}} is fine).
const SESSION_END_ENTRY = {
  hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/session-end-marker.py', timeout: 5 }],
}
const MEMORY_START_ENTRY = {
  matcher: 'startup',
  hooks: [{ type: 'command', command: 'python3 x/memory-replay.py', timeout: 15 }],
}

function template() {
  return { SessionEnd: [SESSION_END_ENTRY], SessionStart: [MEMORY_START_ENTRY] }
}

describe('ensureSessionEndMarkerHook (SessionEnd clean-shutdown marker backfill)', () => {
  it('creates the SessionEnd block for an agent that has none (every agent today)', () => {
    const target: any = { SessionStart: [MEMORY_START_ENTRY] }
    expect(ensureSessionEndMarkerHook(target, template())).toBe(true)
    expect(target.SessionEnd).toHaveLength(1)
    expect(JSON.stringify(target.SessionEnd)).toContain('session-end-marker.py')
    expect(target.SessionStart).toHaveLength(1) // untouched
  })

  it('appends to an existing SessionEnd block without duplicating other entries', () => {
    const other = { hooks: [{ type: 'command', command: 'python3 x/other-end-hook.py', timeout: 5 }] }
    const target: any = { SessionEnd: [other] }
    expect(ensureSessionEndMarkerHook(target, template())).toBe(true)
    expect(target.SessionEnd).toHaveLength(2)
    expect(JSON.stringify(target.SessionEnd)).toContain('other-end-hook.py') // preserved
    expect(JSON.stringify(target.SessionEnd)).toContain('session-end-marker.py')
  })

  it('is idempotent: a second run does not duplicate the marker hook', () => {
    const target: any = {}
    expect(ensureSessionEndMarkerHook(target, template())).toBe(true)
    expect(ensureSessionEndMarkerHook(target, template())).toBe(false)
    const n = target.SessionEnd.filter((e: any) => JSON.stringify(e).includes('session-end-marker.py')).length
    expect(n).toBe(1)
  })

  it('returns false (no-op) when the template defines no SessionEnd marker hook', () => {
    const target: any = {}
    expect(ensureSessionEndMarkerHook(target, { SessionStart: [MEMORY_START_ENTRY] })).toBe(false)
    expect(target.SessionEnd).toBeUndefined()
  })
})
