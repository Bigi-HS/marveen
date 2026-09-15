import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  sessionEndMarkerHookEnabled,
  stripSessionEndMarker,
  ensureSessionEndMarkerHook,
  SESSION_END_MARKER_FLAG,
} from '../web/agent-scaffold.js'

// Template entry exactly as it ships (placeholder unresolved; the merge helper
// only inspects the command substring, so literal {{PROJECT_ROOT}} is fine).
const SESSION_END_ENTRY = {
  hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/session-end-marker.py', timeout: 5 }],
}
const MEMORY_START_ENTRY = {
  matcher: 'startup',
  hooks: [{ type: 'command', command: 'python3 x/memory-replay.py', timeout: 15 }],
}
function template(): any {
  return { SessionEnd: [SESSION_END_ENTRY], SessionStart: [MEMORY_START_ENTRY] }
}

describe('sessionEndMarkerHookEnabled (operator c12-signoff flag-gate)', () => {
  let store: string
  beforeEach(() => { store = mkdtempSync(join(tmpdir(), 'sem-flag-')) })
  afterEach(() => rmSync(store, { recursive: true, force: true }))

  it('is INERT (false) when the flag file is absent -- fail-closed default', () => {
    expect(sessionEndMarkerHookEnabled(store)).toBe(false)
  })

  it('is ACTIVE (true) once the operator touches store/session-end-marker.enabled', () => {
    writeFileSync(join(store, SESSION_END_MARKER_FLAG), '')
    expect(sessionEndMarkerHookEnabled(store)).toBe(true)
  })

  it('exposes the canonical flag filename', () => {
    expect(SESSION_END_MARKER_FLAG).toBe('session-end-marker.enabled')
  })
})

describe('stripSessionEndMarker (gate applied at template-load, covers both inject paths)', () => {
  it('removes the marker entry from the template SessionEnd block', () => {
    const tpl = template()
    stripSessionEndMarker(tpl)
    expect(JSON.stringify(tpl)).not.toContain('session-end-marker.py')
  })

  it('deletes an emptied SessionEnd array (no dangling empty key for the full-seed path)', () => {
    const tpl = template()
    stripSessionEndMarker(tpl)
    expect(tpl.SessionEnd).toBeUndefined()
  })

  it('preserves other SessionEnd hooks, dropping only the marker', () => {
    const other = { hooks: [{ type: 'command', command: 'python3 x/other-end-hook.py', timeout: 5 }] }
    const tpl: any = { SessionEnd: [SESSION_END_ENTRY, other] }
    stripSessionEndMarker(tpl)
    expect(tpl.SessionEnd).toHaveLength(1)
    expect(JSON.stringify(tpl.SessionEnd)).toContain('other-end-hook.py')
    expect(JSON.stringify(tpl.SessionEnd)).not.toContain('session-end-marker.py')
  })

  it('is a no-op when the template has no SessionEnd block', () => {
    const tpl: any = { SessionStart: [MEMORY_START_ENTRY] }
    stripSessionEndMarker(tpl)
    expect(tpl.SessionEnd).toBeUndefined()
    expect(tpl.SessionStart).toHaveLength(1)
  })
})

describe('gate composition: flag absent => marker injection is fully inert', () => {
  it('targeted-backfill path: stripped template makes ensureSessionEndMarkerHook a no-op', () => {
    const tpl = template()
    stripSessionEndMarker(tpl) // simulate the flag-absent gate at template load
    const target: any = {}
    expect(ensureSessionEndMarkerHook(target, tpl)).toBe(false)
    expect(target.SessionEnd).toBeUndefined()
  })

  it('full-seed path: a stripped template block carries no marker to seed', () => {
    const tpl = template()
    stripSessionEndMarker(tpl)
    // ensureAgentHooks seeds tpl.hooks wholesale for a permissions-only agent;
    // after stripping there is nothing marker-shaped left to leak fleet-wide.
    expect(JSON.stringify(tpl)).not.toContain('session-end-marker.py')
  })
})
