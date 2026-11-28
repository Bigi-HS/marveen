// Regression guard: templates/settings.json.template must ship the
// PostToolUse telemetry-emit.py hook so new agents receive P0 bus coverage
// out of the box (card e810151f).
//
// apply-telemetry-hook.py handles EXISTING agents (absolute-path patcher).
// This file ensures the TEMPLATE carries the hook for NEW agents.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function loadTemplate() {
  const tplPath = join(__dirname, '..', '..', 'templates', 'settings.json.template')
  return JSON.parse(readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', '/ROOT'))
}

describe('settings.json.template ships the PostToolUse telemetry-emit hook (card e810151f)', () => {
  it('has a PostToolUse section', () => {
    const tpl = loadTemplate()
    const pt = tpl.hooks?.PostToolUse
    expect(pt).toBeTruthy()
    expect(Array.isArray(pt)).toBe(true)
    expect(pt.length).toBeGreaterThan(0)
  })

  it('has a catch-all (.*) matcher entry running telemetry-emit.py', () => {
    const tpl = loadTemplate()
    const pt: any[] = tpl.hooks?.PostToolUse ?? []
    const entry = pt.find((e: any) => JSON.stringify(e).includes('telemetry-emit.py'))
    expect(entry).toBeTruthy()
    expect(entry.matcher).toBe('.*')
  })

  it('the telemetry-emit hook entry has a timeout', () => {
    const tpl = loadTemplate()
    const pt: any[] = tpl.hooks?.PostToolUse ?? []
    const entry = pt.find((e: any) => JSON.stringify(e).includes('telemetry-emit.py'))
    expect(entry).toBeTruthy()
    const hook = entry.hooks.find((h: any) => h.command?.includes('telemetry-emit.py'))
    expect(hook).toBeTruthy()
    expect(hook.timeout).toBeGreaterThan(0)
  })

  it('PostToolUse section does not break the other hook events', () => {
    const tpl = loadTemplate()
    const hooks = tpl.hooks ?? {}
    // All existing hook events must still be present
    for (const event of ['PreCompact', 'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SessionEnd']) {
      expect(hooks[event]).toBeTruthy()
    }
  })
})
