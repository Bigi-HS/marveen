import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureEgressPiiHook } from '../web/agent-scaffold.js'

// The PreToolUse egress-PII entry exactly as it ships in
// templates/settings.json.template (placeholder unresolved; the merge only
// inspects the command substring so the literal {{PROJECT_ROOT}} is fine).
const EGRESS_ENTRY = {
  matcher: 'mcp__.*|Bash',
  hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/egress-pii-scan.py', timeout: 10 }],
}
const ASK_FIRST_ENTRY = {
  matcher: 'mcp__.*',
  hooks: [{ type: 'command', command: 'python3 x/guardrail-ask-first.py', timeout: 10 }],
}

function template() {
  return { PreToolUse: [EGRESS_ENTRY] }
}

describe('ensureEgressPiiHook (targeted PreToolUse egress-PII merge)', () => {
  it('appends the egress-PII filter to an agent that has hooks but lacks it', () => {
    const target: any = { SessionStart: [{ matcher: 'startup', hooks: [] }] }
    const changed = ensureEgressPiiHook(target, template())
    expect(changed).toBe(true)
    expect(target.PreToolUse).toHaveLength(1)
    expect(JSON.stringify(target.PreToolUse)).toContain('egress-pii-scan.py')
    expect(target.SessionStart).toHaveLength(1)
  })

  it('preserves pre-existing PreToolUse hooks and appends beside them', () => {
    // Real-world case: an agent already carries the ask-first gate. The merge
    // must ADD the egress-PII block, never replace the existing one.
    const target: any = { PreToolUse: [ASK_FIRST_ENTRY] }
    expect(ensureEgressPiiHook(target, template())).toBe(true)
    expect(target.PreToolUse).toHaveLength(2)
    expect(JSON.stringify(target.PreToolUse)).toContain('guardrail-ask-first.py')
    expect(JSON.stringify(target.PreToolUse)).toContain('egress-pii-scan.py')
  })

  it('is idempotent: a second run does not duplicate the hook', () => {
    const target: any = {}
    expect(ensureEgressPiiHook(target, template())).toBe(true)
    expect(ensureEgressPiiHook(target, template())).toBe(false)
    const n = target.PreToolUse.filter((e: any) => JSON.stringify(e).includes('egress-pii-scan.py')).length
    expect(n).toBe(1)
  })

  it('returns false (no-op) when the template defines no egress-PII hook', () => {
    const tplNoGate = { PreToolUse: [ASK_FIRST_ENTRY] }
    const target: any = {}
    expect(ensureEgressPiiHook(target, tplNoGate)).toBe(false)
    expect(target.PreToolUse).toBeUndefined()
  })
})

describe('settings.json.template ships the PreToolUse egress-PII hook', () => {
  it('has an mcp+Bash-matched PreToolUse entry running egress-pii-scan.py', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
    const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
    const pre = tpl.hooks?.PreToolUse ?? []
    const gate = pre.find((e: any) => JSON.stringify(e).includes('egress-pii-scan.py'))
    expect(gate).toBeTruthy()
    // Must cover BOTH the MCP data-carrying sends and the Bash curl surface.
    expect(gate.matcher).toContain('mcp__')
    expect(gate.matcher).toContain('Bash')
  })

  it('the shipped template entry is what ensureEgressPiiHook backfills', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
    const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
    const target: any = {}
    expect(ensureEgressPiiHook(target, tpl.hooks)).toBe(true)
    expect(JSON.stringify(target.PreToolUse)).toContain('egress-pii-scan.py')
  })

  it('ships the egress-PII guard alongside the other PreToolUse guards', () => {
    const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
    const tpl = JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
    const pre = tpl.hooks?.PreToolUse ?? []
    expect(pre.some((e: any) => JSON.stringify(e).includes('guardrail-ask-first.py'))).toBe(true)
    expect(pre.some((e: any) => JSON.stringify(e).includes('guardrail-destructive-bash.py'))).toBe(true)
    expect(pre.some((e: any) => JSON.stringify(e).includes('guardrail-permission-rules.py'))).toBe(true)
    expect(pre.some((e: any) => JSON.stringify(e).includes('egress-pii-scan.py'))).toBe(true)
  })
})
