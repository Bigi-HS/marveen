import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureMemoryHook } from '../web/agent-scaffold.js'

// The SessionStart memory auto-inject hook entry exactly as it ships in
// templates/settings.json.template (placeholder unresolved; ensureMemoryHook
// only inspects the command substring so the literal {{PROJECT_ROOT}} is fine).
const MEMORY_ENTRY = {
  matcher: 'startup',
  hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/memory-replay.py', timeout: 15 }],
}
const TASKSTATE_ENTRY = {
  matcher: 'compact|resume',
  hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/taskstate-replay.py', timeout: 15 }],
}
const PRECOMPACT_ENTRY = {
  matcher: 'auto',
  hooks: [{ type: 'agent', prompt: 'save memories...', timeout: 180 }],
}

function template() {
  return { PreCompact: [PRECOMPACT_ENTRY], SessionStart: [TASKSTATE_ENTRY, MEMORY_ENTRY] }
}

describe('ensureMemoryHook (targeted SessionStart memory-hook merge)', () => {
  it('appends the memory hook to an agent that has hooks but lacks it', () => {
    // The real-world case: a live agent scaffolded with PreCompact + taskstate
    // before the memory hook existed. The all-or-nothing seed skips it; this
    // targeted merge must add only the memory entry.
    const target: any = { PreCompact: [PRECOMPACT_ENTRY], SessionStart: [TASKSTATE_ENTRY] }
    const changed = ensureMemoryHook(target, template())
    expect(changed).toBe(true)
    expect(target.SessionStart).toHaveLength(2)
    expect(JSON.stringify(target.SessionStart)).toContain('memory-replay.py')
    // The pre-existing taskstate entry is preserved, not replaced.
    expect(JSON.stringify(target.SessionStart)).toContain('taskstate-replay.py')
    // Untouched hook families stay exactly as they were.
    expect(target.PreCompact).toEqual([PRECOMPACT_ENTRY])
  })

  it('is idempotent: a second run does not duplicate the hook', () => {
    const target: any = { SessionStart: [TASKSTATE_ENTRY] }
    expect(ensureMemoryHook(target, template())).toBe(true)
    expect(ensureMemoryHook(target, template())).toBe(false)  // already present
    const memCount = target.SessionStart.filter((e: any) =>
      JSON.stringify(e).includes('memory-replay.py')).length
    expect(memCount).toBe(1)
  })

  it('creates the SessionStart array when the agent has hooks but no SessionStart', () => {
    // An agent with only a PreCompact block: SessionStart is absent, not [].
    const target: any = { PreCompact: [PRECOMPACT_ENTRY] }
    expect(ensureMemoryHook(target, template())).toBe(true)
    expect(target.SessionStart).toHaveLength(1)
    expect(JSON.stringify(target.SessionStart)).toContain('memory-replay.py')
  })

  it('returns false (no-op) when the template defines no memory hook', () => {
    // Defensive: if a future template drops the memory entry, the merge must
    // not invent one or throw.
    const tplNoMemory = { SessionStart: [TASKSTATE_ENTRY] }
    const target: any = { SessionStart: [TASKSTATE_ENTRY] }
    expect(ensureMemoryHook(target, tplNoMemory)).toBe(false)
    expect(target.SessionStart).toHaveLength(1)
  })

  it('does not flag a match when an unrelated command merely resembles the marker', () => {
    // A command that references a different replay script must not be mistaken
    // for the memory hook (substring is `memory-replay.py`, exact).
    const target: any = {
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'python3 x/taskstate-replay.py' }] }],
    }
    expect(ensureMemoryHook(target, template())).toBe(true)
    expect(target.SessionStart).toHaveLength(2)
  })
})

describe('settings.json.template ships the memory SessionStart hook', () => {
  it('has a startup-matched SessionStart entry running memory-replay.py', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
    const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
    const start = tpl.hooks?.SessionStart ?? []
    const mem = start.find((e: any) => JSON.stringify(e).includes('memory-replay.py'))
    expect(mem).toBeTruthy()
    expect(mem.matcher).toBe('startup')
    // taskstate replay stays a separate entry (compact|resume), not merged.
    const ts = start.find((e: any) => JSON.stringify(e).includes('taskstate-replay.py'))
    expect(ts.matcher).toBe('compact|resume')
  })

  // The template + the merge helper must agree: feeding the real template hooks
  // through ensureMemoryHook against an agent that lacks the hook adds exactly it.
  it('the shipped template entry is what ensureMemoryHook backfills', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
    const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
    const target: any = { SessionStart: [TASKSTATE_ENTRY] }
    expect(ensureMemoryHook(target, tpl.hooks)).toBe(true)
    expect(JSON.stringify(target.SessionStart)).toContain('memory-replay.py')
  })
})
