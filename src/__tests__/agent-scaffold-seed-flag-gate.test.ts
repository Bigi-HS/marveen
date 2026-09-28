import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyFlagGate, SESSION_END_MARKER_FLAG } from '../web/agent-scaffold.js'

// The three memory-continuity hooks that share the operator c12-signoff flag.
// A newly scaffolded agent (scaffoldAgentDir) seeds the RAW template; before this
// fix it copied them verbatim, bypassing the flag-gate that ensureAgentHooks
// applies on the boot backfill path -- so a new agent (or the c12 sandbox, which
// scaffolds through the same path) got S1/S3 hooks LIVE while the flag was off.
function templateHooks(): any {
  return {
    SessionEnd: [
      { hooks: [{ type: 'command', command: 'python3 x/session-end-marker.py', timeout: 5 }] },
    ],
    SessionStart: [
      { matcher: 'startup', hooks: [{ type: 'command', command: 'python3 x/memory-replay.py', timeout: 15 }] },
      { matcher: 'startup|resume', hooks: [{ type: 'command', command: 'python3 x/checkpoint-replay.py', timeout: 15 }] },
    ],
    PreCompact: [
      { hooks: [{ type: 'command', command: 'python3 x/checkpoint-write.py', timeout: 15 }] },
    ],
  }
}

describe('applyFlagGate (unifies the operator flag-gate across seed + backfill)', () => {
  let store: string
  beforeEach(() => { store = mkdtempSync(join(tmpdir(), 'seed-gate-')) })
  afterEach(() => rmSync(store, { recursive: true, force: true }))

  it('flag ABSENT: strips the SessionEnd marker AND both S3 checkpoint hooks', () => {
    const hooks = templateHooks()
    applyFlagGate(hooks, store)
    const blob = JSON.stringify(hooks)
    expect(blob).not.toContain('session-end-marker.py')
    expect(blob).not.toContain('checkpoint-replay.py')
    expect(blob).not.toContain('checkpoint-write.py')
  })

  it('flag ABSENT: preserves unrelated hooks (memory-replay survives)', () => {
    const hooks = templateHooks()
    applyFlagGate(hooks, store)
    expect(JSON.stringify(hooks)).toContain('memory-replay.py')
  })

  // Bidirectional idempotence (marveen decision, S1 followup): flag-OFF must also
  // STRIP an already-present marker/checkpoint hook from an agent's EXISTING hooks
  // block -- not merely refrain from adding -- so a contaminated agent (raw-seeded
  // before the gate fix, e.g. servo-skull) and the c12 sandbox baseline self-heal
  // to the inert baseline on the next boot backfill while the flag is still off.
  it('flag ABSENT: reports a change when it removed hooks (returns true)', () => {
    const hooks = templateHooks()
    expect(applyFlagGate(hooks, store)).toBe(true)
  })

  it('flag ABSENT: returns false on an already-clean block (idempotent no-op)', () => {
    const hooks = templateHooks()
    applyFlagGate(hooks, store)          // first pass strips
    expect(applyFlagGate(hooks, store)).toBe(false)  // second pass: nothing left to strip
  })

  it('flag PRESENT: returns false (never mutates when active)', () => {
    writeFileSync(join(store, SESSION_END_MARKER_FLAG), '')
    const hooks = templateHooks()
    expect(applyFlagGate(hooks, store)).toBe(false)
  })

  it('flag PRESENT: leaves all three memory-continuity hooks intact', () => {
    writeFileSync(join(store, SESSION_END_MARKER_FLAG), '')
    const hooks = templateHooks()
    applyFlagGate(hooks, store)
    const blob = JSON.stringify(hooks)
    expect(blob).toContain('session-end-marker.py')
    expect(blob).toContain('checkpoint-replay.py')
    expect(blob).toContain('checkpoint-write.py')
  })
})

describe('scaffold seed path parity: gated raw template carries no live hooks', () => {
  let store: string
  beforeEach(() => { store = mkdtempSync(join(tmpdir(), 'seed-parity-')) })
  afterEach(() => rmSync(store, { recursive: true, force: true }))

  // Mirror what scaffoldAgentDir does for a brand-new agent: parse the raw
  // template, apply the gate, and prove the seeded settings would be inert.
  it('flag ABSENT: a seeded settings.json would contain no S1/S3 marker', () => {
    const parsed = { hooks: templateHooks() }
    applyFlagGate(parsed.hooks, store)
    const seeded = JSON.stringify(parsed, null, 2)
    expect(seeded).not.toContain('session-end-marker.py')
    expect(seeded).not.toContain('checkpoint-replay.py')
    expect(seeded).not.toContain('checkpoint-write.py')
  })
})
