import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureAskFirstHook } from '../web/agent-scaffold.js'

// The PreToolUse ask-first entry exactly as it ships in
// templates/settings.json.template (placeholder unresolved; ensureAskFirstHook
// only inspects the command substring so the literal {{PROJECT_ROOT}} is fine).
const ASK_FIRST_ENTRY = {
  matcher: 'mcp__.*',
  hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/guardrail-ask-first.py', timeout: 10 }],
}
const TELEGRAM_GUARD_ENTRY = {
  matcher: 'mcp__plugin_telegram_telegram__.*',
  hooks: [{ type: 'command', command: 'python3 x/guardrail-telegram-chat.py', timeout: 10 }],
}

function template() {
  return { PreToolUse: [ASK_FIRST_ENTRY] }
}

describe('ensureAskFirstHook (targeted PreToolUse ask-first merge)', () => {
  it('appends the ask-first gate to an agent that has hooks but lacks it', () => {
    const target: any = { SessionStart: [{ matcher: 'startup', hooks: [] }] }
    const changed = ensureAskFirstHook(target, template())
    expect(changed).toBe(true)
    expect(target.PreToolUse).toHaveLength(1)
    expect(JSON.stringify(target.PreToolUse)).toContain('guardrail-ask-first.py')
    expect(target.SessionStart).toHaveLength(1)
  })

  it('preserves pre-existing PreToolUse hooks and appends beside them', () => {
    // Real-world case: an agent already carries the telegram guardrail. The
    // merge must ADD the ask-first gate, never replace the existing one.
    const target: any = { PreToolUse: [TELEGRAM_GUARD_ENTRY] }
    expect(ensureAskFirstHook(target, template())).toBe(true)
    expect(target.PreToolUse).toHaveLength(2)
    expect(JSON.stringify(target.PreToolUse)).toContain('guardrail-telegram-chat.py')
    expect(JSON.stringify(target.PreToolUse)).toContain('guardrail-ask-first.py')
  })

  it('is idempotent: a second run does not duplicate the hook', () => {
    const target: any = {}
    expect(ensureAskFirstHook(target, template())).toBe(true)
    expect(ensureAskFirstHook(target, template())).toBe(false)
    const n = target.PreToolUse.filter((e: any) => JSON.stringify(e).includes('guardrail-ask-first.py')).length
    expect(n).toBe(1)
  })

  it('returns false (no-op) when the template defines no ask-first hook', () => {
    const tplNoGate = { PreToolUse: [TELEGRAM_GUARD_ENTRY] }
    const target: any = {}
    expect(ensureAskFirstHook(target, tplNoGate)).toBe(false)
    expect(target.PreToolUse).toBeUndefined()
  })
})

describe('settings.json.template ships the PreToolUse ask-first hook', () => {
  it('has an mcp-matched PreToolUse entry running guardrail-ask-first.py', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
    const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
    const pre = tpl.hooks?.PreToolUse ?? []
    const gate = pre.find((e: any) => JSON.stringify(e).includes('guardrail-ask-first.py'))
    expect(gate).toBeTruthy()
    expect(gate.matcher).toBe('mcp__.*')
  })

  it('the shipped template entry is what ensureAskFirstHook backfills', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
    const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
    const target: any = {}
    expect(ensureAskFirstHook(target, tpl.hooks)).toBe(true)
    expect(JSON.stringify(target.PreToolUse)).toContain('guardrail-ask-first.py')
  })

  it('ships both PreToolUse guards side by side (telegram + ask-first)', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
    const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
    const pre = tpl.hooks?.PreToolUse ?? []
    expect(pre.some((e: any) => JSON.stringify(e).includes('guardrail-telegram-chat.py'))).toBe(true)
    expect(pre.some((e: any) => JSON.stringify(e).includes('guardrail-ask-first.py'))).toBe(true)
  })
})
