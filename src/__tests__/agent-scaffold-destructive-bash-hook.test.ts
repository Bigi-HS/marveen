import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDestructiveBashHook } from '../web/agent-scaffold.js'

// The PreToolUse destructive-Bash entry exactly as it ships in
// templates/settings.json.template (placeholder unresolved; the merge only
// inspects the command substring so the literal {{PROJECT_ROOT}} is fine).
const DESTRUCTIVE_ENTRY = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/guardrail-destructive-bash.py', timeout: 10 }],
}
const ASK_FIRST_ENTRY = {
  matcher: 'mcp__.*',
  hooks: [{ type: 'command', command: 'python3 x/guardrail-ask-first.py', timeout: 10 }],
}

function template() {
  return { PreToolUse: [DESTRUCTIVE_ENTRY] }
}

describe('ensureDestructiveBashHook (targeted PreToolUse destructive-Bash merge)', () => {
  it('appends the destructive-Bash gate to an agent that has hooks but lacks it', () => {
    const target: any = { SessionStart: [{ matcher: 'startup', hooks: [] }] }
    const changed = ensureDestructiveBashHook(target, template())
    expect(changed).toBe(true)
    expect(target.PreToolUse).toHaveLength(1)
    expect(JSON.stringify(target.PreToolUse)).toContain('guardrail-destructive-bash.py')
    expect(target.SessionStart).toHaveLength(1)
  })

  it('preserves pre-existing PreToolUse hooks and appends beside them', () => {
    // Real-world case: an agent already carries the ask-first gate. The merge
    // must ADD the destructive-Bash block, never replace the existing one.
    const target: any = { PreToolUse: [ASK_FIRST_ENTRY] }
    expect(ensureDestructiveBashHook(target, template())).toBe(true)
    expect(target.PreToolUse).toHaveLength(2)
    expect(JSON.stringify(target.PreToolUse)).toContain('guardrail-ask-first.py')
    expect(JSON.stringify(target.PreToolUse)).toContain('guardrail-destructive-bash.py')
  })

  it('is idempotent: a second run does not duplicate the hook', () => {
    const target: any = {}
    expect(ensureDestructiveBashHook(target, template())).toBe(true)
    expect(ensureDestructiveBashHook(target, template())).toBe(false)
    const n = target.PreToolUse.filter((e: any) => JSON.stringify(e).includes('guardrail-destructive-bash.py')).length
    expect(n).toBe(1)
  })

  it('returns false (no-op) when the template defines no destructive-Bash hook', () => {
    const tplNoGate = { PreToolUse: [ASK_FIRST_ENTRY] }
    const target: any = {}
    expect(ensureDestructiveBashHook(target, tplNoGate)).toBe(false)
    expect(target.PreToolUse).toBeUndefined()
  })
})

describe('settings.json.template ships the PreToolUse destructive-Bash hook', () => {
  it('has a Bash-matched PreToolUse entry running guardrail-destructive-bash.py', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
    const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
    const pre = tpl.hooks?.PreToolUse ?? []
    const gate = pre.find((e: any) => JSON.stringify(e).includes('guardrail-destructive-bash.py'))
    expect(gate).toBeTruthy()
    expect(gate.matcher).toBe('Bash')
  })

  it('the shipped template entry is what ensureDestructiveBashHook backfills', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
    const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
    const target: any = {}
    expect(ensureDestructiveBashHook(target, tpl.hooks)).toBe(true)
    expect(JSON.stringify(target.PreToolUse)).toContain('guardrail-destructive-bash.py')
  })

  it('ships all three PreToolUse guards side by side (telegram + ask-first + destructive-Bash)', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
    const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
    const pre = tpl.hooks?.PreToolUse ?? []
    expect(pre.some((e: any) => JSON.stringify(e).includes('guardrail-telegram-chat.py'))).toBe(true)
    expect(pre.some((e: any) => JSON.stringify(e).includes('guardrail-ask-first.py'))).toBe(true)
    expect(pre.some((e: any) => JSON.stringify(e).includes('guardrail-destructive-bash.py'))).toBe(true)
  })
})
