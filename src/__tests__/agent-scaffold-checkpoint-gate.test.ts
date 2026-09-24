import { describe, it, expect } from 'vitest'
import {
  stripCheckpointHooks,
  ensureCheckpointReplayHook,
  ensureCheckpointWriteHooks,
} from '../web/agent-scaffold.js'

// The S3 checkpoint hooks share the S1 SessionEnd-marker operator flag so
// S1+S2+S3 co-activate on the single flag-touch. When the flag is OFF the
// template is stripped of ALL checkpoint hooks (replay + the 3 write triggers),
// so NEITHER the full seed nor the targeted backfill can inject them =>
// deploy-inert. These tests lock that gate at the template-strip + backfill
// level (the same layer the S1 gate is tested at).

const REPLAY_ENTRY = {
  matcher: 'startup|compact|resume',
  hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/checkpoint-replay.py', timeout: 15 }],
}
const PRECOMPACT_ENTRY = {
  matcher: 'auto',
  hooks: [
    { type: 'agent', prompt: 'memory save prompt' }, // co-located, must be preserved
    { type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/checkpoint-write.py precompact', timeout: 5 },
  ],
}
const SESSIONEND_ENTRY = {
  hooks: [
    { type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/session-end-marker.py', timeout: 5 },
    { type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/checkpoint-write.py sessionend', timeout: 5 },
  ],
}
const TICK_ENTRY = {
  hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/checkpoint-write.py tick', timeout: 5 }],
}

// Deep-clone so a mutating strip in one test can never leak into another via the
// shared entry constants (stripCheckpointHooks mutates entry.hooks in place).
function template(): any {
  return structuredClone({
    SessionStart: [REPLAY_ENTRY],
    PreCompact: [PRECOMPACT_ENTRY],
    SessionEnd: [SESSIONEND_ENTRY],
    UserPromptSubmit: [TICK_ENTRY],
  })
}

describe('stripCheckpointHooks (flag-off gate at template load)', () => {
  it('removes the SessionStart checkpoint-replay entry', () => {
    const tpl = template()
    stripCheckpointHooks(tpl)
    expect(JSON.stringify(tpl)).not.toContain('checkpoint-replay.py')
    expect(tpl.SessionStart).toBeUndefined() // replay-only entry -> whole event dropped
  })

  it('removes ALL checkpoint-write triggers (precompact/sessionend/tick)', () => {
    const tpl = template()
    stripCheckpointHooks(tpl)
    expect(JSON.stringify(tpl)).not.toContain('checkpoint-write.py')
  })

  it('PRESERVES the co-located PreCompact memory-save prompt', () => {
    const tpl = template()
    stripCheckpointHooks(tpl)
    expect(tpl.PreCompact).toHaveLength(1)
    expect(JSON.stringify(tpl.PreCompact)).toContain('memory save prompt')
  })

  it('PRESERVES the co-located SessionEnd S1 marker (only the write hook goes)', () => {
    const tpl = template()
    stripCheckpointHooks(tpl)
    expect(JSON.stringify(tpl.SessionEnd)).toContain('session-end-marker.py')
    expect(JSON.stringify(tpl.SessionEnd)).not.toContain('checkpoint-write.py')
  })

  it('drops the tick-only UserPromptSubmit entry entirely', () => {
    const tpl = template()
    stripCheckpointHooks(tpl)
    expect(tpl.UserPromptSubmit).toBeUndefined()
  })
})

describe('gate composition: stripped template => backfills are no-ops (deploy-inert)', () => {
  it('ensureCheckpointReplayHook does nothing against a stripped template', () => {
    const tpl = template()
    stripCheckpointHooks(tpl)
    const target: any = {}
    expect(ensureCheckpointReplayHook(target, tpl)).toBe(false)
    expect(target.SessionStart).toBeUndefined()
  })

  it('ensureCheckpointWriteHooks does nothing against a stripped template', () => {
    const tpl = template()
    stripCheckpointHooks(tpl)
    const target: any = { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'x' }] }] }
    expect(ensureCheckpointWriteHooks(target, tpl)).toBe(false)
  })
})

describe('flag-ON backfills (idempotent, ADD-only, no co-located duplication)', () => {
  it('replay backfill appends once, second call is a no-op', () => {
    const target: any = { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'x/memory-replay.py' }] }] }
    expect(ensureCheckpointReplayHook(target, template())).toBe(true)
    expect(JSON.stringify(target)).toContain('checkpoint-replay.py')
    expect(ensureCheckpointReplayHook(target, template())).toBe(false)
    // exactly one occurrence
    expect((JSON.stringify(target).match(/checkpoint-replay\.py/g) || []).length).toBe(1)
  })

  it('write backfill adds ONLY the command, never the co-located agent prompt', () => {
    // agent already has a PreCompact block with the memory-save prompt but no write hook
    const target: any = { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'existing memory prompt' }] }] }
    expect(ensureCheckpointWriteHooks(target, template())).toBe(true)
    // the memory prompt appears exactly once (not duplicated by the backfill)
    expect((JSON.stringify(target).match(/existing memory prompt/g) || []).length).toBe(1)
    // and the write hook is present for all three events
    expect(JSON.stringify(target)).toContain('checkpoint-write.py precompact')
    expect(JSON.stringify(target)).toContain('checkpoint-write.py sessionend')
    expect(JSON.stringify(target)).toContain('checkpoint-write.py tick')
  })

  it('write backfill is idempotent (second call no-op)', () => {
    const target: any = {}
    expect(ensureCheckpointWriteHooks(target, template())).toBe(true)
    expect(ensureCheckpointWriteHooks(target, template())).toBe(false)
  })
})
