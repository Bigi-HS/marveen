import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureGuardrailHook } from '../web/agent-scaffold.js'

// The PreToolUse guardrail entry exactly as it ships in
// templates/settings.json.template (placeholder unresolved; ensureGuardrailHook
// only inspects the command substring so the literal {{PROJECT_ROOT}} is fine).
const GUARDRAIL_ENTRY = {
  matcher: 'mcp__plugin_telegram_telegram__.*',
  hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/guardrail-telegram-chat.py', timeout: 10 }],
}
const FORGE_DEPLOY_ENTRY = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: 'python3 x/forge-deploy-guard.py', timeout: 10 }],
}

function template() {
  return { PreToolUse: [GUARDRAIL_ENTRY] }
}

describe('ensureGuardrailHook (targeted PreToolUse guardrail merge)', () => {
  it('appends the guardrail to an agent that has hooks but lacks it', () => {
    const target: any = { SessionStart: [{ matcher: 'startup', hooks: [] }] }
    const changed = ensureGuardrailHook(target, template())
    expect(changed).toBe(true)
    expect(target.PreToolUse).toHaveLength(1)
    expect(JSON.stringify(target.PreToolUse)).toContain('guardrail-telegram-chat.py')
    // Untouched hook families stay exactly as they were.
    expect(target.SessionStart).toHaveLength(1)
  })

  it('preserves a pre-existing PreToolUse hook and appends the guardrail beside it', () => {
    // The real-world case: an agent (e.g. Forge) already carries a PreToolUse
    // hook. The merge must ADD the guardrail, never replace the existing one.
    const target: any = { PreToolUse: [FORGE_DEPLOY_ENTRY] }
    expect(ensureGuardrailHook(target, template())).toBe(true)
    expect(target.PreToolUse).toHaveLength(2)
    expect(JSON.stringify(target.PreToolUse)).toContain('forge-deploy-guard.py')
    expect(JSON.stringify(target.PreToolUse)).toContain('guardrail-telegram-chat.py')
  })

  it('is idempotent: a second run does not duplicate the hook', () => {
    const target: any = {}
    expect(ensureGuardrailHook(target, template())).toBe(true)
    expect(ensureGuardrailHook(target, template())).toBe(false)
    const n = target.PreToolUse.filter((e: any) => JSON.stringify(e).includes('guardrail-telegram-chat.py')).length
    expect(n).toBe(1)
  })

  it('returns false (no-op) when the template defines no guardrail hook', () => {
    const tplNoGuard = { PreToolUse: [FORGE_DEPLOY_ENTRY] }
    const target: any = {}
    expect(ensureGuardrailHook(target, tplNoGuard)).toBe(false)
    expect(target.PreToolUse).toBeUndefined()
  })
})

describe('settings.json.template ships the PreToolUse guardrail hook', () => {
  it('has a telegram-matched PreToolUse entry running guardrail-telegram-chat.py', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
    const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
    const pre = tpl.hooks?.PreToolUse ?? []
    const guard = pre.find((e: any) => JSON.stringify(e).includes('guardrail-telegram-chat.py'))
    expect(guard).toBeTruthy()
    expect(guard.matcher).toBe('mcp__plugin_telegram_telegram__.*')
  })

  // The template + the merge helper must agree: feeding the real template hooks
  // through ensureGuardrailHook against an agent that lacks it adds exactly it.
  it('the shipped template entry is what ensureGuardrailHook backfills', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
    const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
    const target: any = {}
    expect(ensureGuardrailHook(target, tpl.hooks)).toBe(true)
    expect(JSON.stringify(target.PreToolUse)).toContain('guardrail-telegram-chat.py')
  })
})
