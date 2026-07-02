import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureSessionEnforceHook, ensureFreshnessNudgeHook } from '../web/agent-scaffold.js'

// The template entries exactly as they ship (placeholder unresolved; the merge
// helpers only inspect the command substring, so literal {{PROJECT_ROOT}} is fine).
const SESSION_ENFORCE_ENTRY = {
  matcher: 'startup|resume',
  hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/session-start-enforce.py', timeout: 5 }],
}
const FRESHNESS_ENTRY = {
  hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/prompt-freshness-nudge.py', timeout: 5 }],
}
const MEMORY_START_ENTRY = {
  matcher: 'startup',
  hooks: [{ type: 'command', command: 'python3 x/memory-replay.py', timeout: 15 }],
}
const LEDGER_PROMPT_ENTRY = {
  hooks: [{ type: 'command', command: 'python3 x/ledger-capture.py', timeout: 15 }],
}

function template() {
  return { SessionStart: [SESSION_ENFORCE_ENTRY], UserPromptSubmit: [FRESHNESS_ENTRY] }
}

describe('ensureSessionEnforceHook (SessionStart per-agent reminder backfill)', () => {
  it('appends the reminder to an agent that has SessionStart hooks but lacks it', () => {
    const target: any = { SessionStart: [MEMORY_START_ENTRY] }
    expect(ensureSessionEnforceHook(target, template())).toBe(true)
    expect(target.SessionStart).toHaveLength(2)
    expect(JSON.stringify(target.SessionStart)).toContain('memory-replay.py')       // preserved
    expect(JSON.stringify(target.SessionStart)).toContain('session-start-enforce.py')
  })

  it('is idempotent: a second run does not duplicate the reminder', () => {
    const target: any = {}
    expect(ensureSessionEnforceHook(target, template())).toBe(true)
    expect(ensureSessionEnforceHook(target, template())).toBe(false)
    const n = target.SessionStart.filter((e: any) => JSON.stringify(e).includes('session-start-enforce.py')).length
    expect(n).toBe(1)
  })

  it('returns false (no-op) when the template defines no reminder hook', () => {
    const target: any = {}
    expect(ensureSessionEnforceHook(target, { SessionStart: [MEMORY_START_ENTRY] })).toBe(false)
    expect(target.SessionStart).toBeUndefined()
  })
})

describe('ensureFreshnessNudgeHook (UserPromptSubmit nudge backfill)', () => {
  it('creates the UserPromptSubmit block for an agent that has none (hibiki case)', () => {
    // hibiki ships hooks with SessionStart/PreToolUse but NO UserPromptSubmit.
    const target: any = { SessionStart: [MEMORY_START_ENTRY] }
    expect(ensureFreshnessNudgeHook(target, template())).toBe(true)
    expect(target.UserPromptSubmit).toHaveLength(1)
    expect(JSON.stringify(target.UserPromptSubmit)).toContain('prompt-freshness-nudge.py')
    expect(target.SessionStart).toHaveLength(1)  // untouched
  })

  it('preserves a pre-existing UserPromptSubmit hook and appends the nudge beside it', () => {
    const target: any = { UserPromptSubmit: [LEDGER_PROMPT_ENTRY] }
    expect(ensureFreshnessNudgeHook(target, template())).toBe(true)
    expect(target.UserPromptSubmit).toHaveLength(2)
    expect(JSON.stringify(target.UserPromptSubmit)).toContain('ledger-capture.py')       // preserved
    expect(JSON.stringify(target.UserPromptSubmit)).toContain('prompt-freshness-nudge.py')
  })

  it('is idempotent: a second run does not duplicate the nudge', () => {
    const target: any = {}
    expect(ensureFreshnessNudgeHook(target, template())).toBe(true)
    expect(ensureFreshnessNudgeHook(target, template())).toBe(false)
    const n = target.UserPromptSubmit.filter((e: any) => JSON.stringify(e).includes('prompt-freshness-nudge.py')).length
    expect(n).toBe(1)
  })

  it('returns false (no-op) when the template defines no nudge hook', () => {
    const target: any = {}
    expect(ensureFreshnessNudgeHook(target, { UserPromptSubmit: [LEDGER_PROMPT_ENTRY] })).toBe(false)
    expect(target.UserPromptSubmit).toBeUndefined()
  })
})

describe('settings.json.template ships the enforcement bundle hooks', () => {
  const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
  const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))

  it('has a startup|resume SessionStart entry running session-start-enforce.py', () => {
    const ss = tpl.hooks?.SessionStart ?? []
    const e = ss.find((x: any) => JSON.stringify(x).includes('session-start-enforce.py'))
    expect(e).toBeTruthy()
    expect(e.matcher).toBe('startup|resume')
  })

  it('has a UserPromptSubmit entry running prompt-freshness-nudge.py', () => {
    const ups = tpl.hooks?.UserPromptSubmit ?? []
    const e = ups.find((x: any) => JSON.stringify(x).includes('prompt-freshness-nudge.py'))
    expect(e).toBeTruthy()
  })

  it('the shipped template entries are what the merge helpers backfill', () => {
    const target: any = {}
    expect(ensureSessionEnforceHook(target, tpl.hooks)).toBe(true)
    expect(ensureFreshnessNudgeHook(target, tpl.hooks)).toBe(true)
    expect(JSON.stringify(target.SessionStart)).toContain('session-start-enforce.py')
    expect(JSON.stringify(target.UserPromptSubmit)).toContain('prompt-freshness-nudge.py')
  })
})
