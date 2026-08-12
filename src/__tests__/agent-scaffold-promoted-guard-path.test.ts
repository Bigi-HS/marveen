import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensurePermissionRulesHook, ensurePromotedGuardPath } from '../web/agent-scaffold.js'

// The pre-promotion spelling, exactly as it still sits in every existing
// agent's settings.json, and the promoted spelling the template now ships.
const LEGACY_COMMAND = 'python3 /ROOT/scripts/hooks/guardrail-permission-rules.py'
const PROMOTED_COMMAND = 'python3 /ROOT/.guard/guardrail-permission-rules.py'

function legacyTarget() {
  return {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 /ROOT/scripts/hooks/guardrail-destructive-bash.py', timeout: 10 }] },
      { matcher: 'Bash|Write|Edit', hooks: [{ type: 'command', command: LEGACY_COMMAND, timeout: 10 }] },
    ],
  } as any
}

function promotedTemplate() {
  return {
    PreToolUse: [
      { matcher: 'Bash|Write|Edit', hooks: [{ type: 'command', command: PROMOTED_COMMAND, timeout: 10 }] },
    ],
  } as any
}

// This is the gap that shipped: the pin reached the template and the repo-root
// config, and nothing else. 28 of the fleet's 29 live settings.json files kept
// naming scripts/hooks/ directly, so an unreviewed edit there still went live
// on their next session start -- the exact property the promotion gate exists
// to remove.
describe('the ADD-only merge cannot migrate a path (why ensurePromotedGuardPath exists)', () => {
  it('leaves the legacy path in place, because the marker is the bare filename', () => {
    const target = legacyTarget()
    // Same filename -> entryReferences() matches -> "already present" -> no-op.
    expect(ensurePermissionRulesHook(target, promotedTemplate())).toBe(false)
    expect(JSON.stringify(target)).toContain('scripts/hooks/guardrail-permission-rules.py')
    expect(JSON.stringify(target)).not.toContain('.guard/')
  })
})

describe('ensurePromotedGuardPath (targeted path migration, the one rewrite)', () => {
  it('rewrites the legacy command to the promoted one the template ships', () => {
    const target = legacyTarget()
    expect(ensurePromotedGuardPath(target, promotedTemplate())).toBe(true)
    expect(target.PreToolUse[1].hooks[0].command).toBe(PROMOTED_COMMAND)
  })

  it('is idempotent: a second run reports no change', () => {
    const target = legacyTarget()
    expect(ensurePromotedGuardPath(target, promotedTemplate())).toBe(true)
    expect(ensurePromotedGuardPath(target, promotedTemplate())).toBe(false)
  })

  it('touches the command only, never the matcher or timeout', () => {
    const target = legacyTarget()
    ensurePromotedGuardPath(target, promotedTemplate())
    expect(target.PreToolUse[1].matcher).toBe('Bash|Write|Edit')
    expect(target.PreToolUse[1].hooks[0].timeout).toBe(10)
    expect(target.PreToolUse[1].hooks[0].type).toBe('command')
  })

  it('leaves the other two guards on the checkout path (they have no canary yet)', () => {
    // The scope of this migration is an unstated claim, so it gets asserted:
    // promoting a guard that cannot be canaried would move it behind a gate
    // that cannot actually gate it.
    const target = legacyTarget()
    ensurePromotedGuardPath(target, promotedTemplate())
    expect(target.PreToolUse[0].hooks[0].command).toBe('python3 /ROOT/scripts/hooks/guardrail-destructive-bash.py')
  })

  it('refuses to invent a path when the template itself is not promoted', () => {
    const unpromoted = { PreToolUse: [{ matcher: 'Bash|Write|Edit', hooks: [{ type: 'command', command: LEGACY_COMMAND }] }] } as any
    const target = legacyTarget()
    expect(ensurePromotedGuardPath(target, unpromoted)).toBe(false)
    expect(target.PreToolUse[1].hooks[0].command).toBe(LEGACY_COMMAND)
  })

  it('adds nothing to an agent that carries no permission-rules hook at all', () => {
    // That case belongs to ensurePermissionRulesHook; a migration that also
    // installs would hide which of the two actually ran.
    const target = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 /ROOT/scripts/hooks/guardrail-destructive-bash.py' }] }] } as any
    expect(ensurePromotedGuardPath(target, promotedTemplate())).toBe(false)
    expect(target.PreToolUse).toHaveLength(1)
  })

  it('migrates every matching entry, not just the first', () => {
    const target = {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: LEGACY_COMMAND }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: LEGACY_COMMAND }] },
      ],
    } as any
    expect(ensurePromotedGuardPath(target, promotedTemplate())).toBe(true)
    expect(JSON.stringify(target)).not.toContain('scripts/hooks/guardrail-permission-rules.py')
  })

  it('is a no-op on a target with no PreToolUse block', () => {
    const target = { SessionStart: [] } as any
    expect(ensurePromotedGuardPath(target, promotedTemplate())).toBe(false)
  })
})

describe('the shipped template drives the migration', () => {
  const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
  const tpl = () => JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))

  it('migrates a legacy agent onto the promoted path the template actually ships', () => {
    const target = legacyTarget()
    expect(ensurePromotedGuardPath(target, tpl().hooks)).toBe(true)
    expect(target.PreToolUse[1].hooks[0].command).toContain('/.guard/guardrail-permission-rules.py')
  })

  it('the template still runs the other two guards from the checkout', () => {
    const pre = tpl().hooks.PreToolUse as any[]
    const cmds = JSON.stringify(pre)
    expect(cmds).toContain('scripts/hooks/guardrail-ask-first.py')
    expect(cmds).toContain('scripts/hooks/guardrail-destructive-bash.py')
    expect(cmds).not.toContain('scripts/hooks/guardrail-permission-rules.py')
  })
})
