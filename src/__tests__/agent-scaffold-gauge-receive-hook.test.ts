import { describe, it, expect } from 'vitest'
import { ensureGaugeReceiveHook } from '../web/agent-scaffold.js'

// Template entry as it ships in settings.json.template. The merge helper only
// inspects the command substring, so literal {{PROJECT_ROOT}} is fine here.
const GAUGE_RECEIVE_ENTRY = {
  hooks: [{ type: 'command', command: 'python3 {{PROJECT_ROOT}}/scripts/hooks/channel-listener-gauge-write.py', timeout: 3 }],
}

const FRESHNESS_NUDGE_ENTRY = {
  hooks: [{ type: 'command', command: 'python3 x/prompt-freshness-nudge.py', timeout: 5 }],
}

function template() {
  return { UserPromptSubmit: [FRESHNESS_NUDGE_ENTRY, GAUGE_RECEIVE_ENTRY] }
}

describe('ensureGaugeReceiveHook (d2f8dae2 UserPromptSubmit gauge backfill)', () => {
  it('creates the UserPromptSubmit block for an agent that has none', () => {
    const target: any = {}
    expect(ensureGaugeReceiveHook(target, template())).toBe(true)
    expect(target.UserPromptSubmit).toBeDefined()
    expect(JSON.stringify(target.UserPromptSubmit)).toContain('channel-listener-gauge-write.py')
  })

  it('appends to an existing UserPromptSubmit block without touching other entries', () => {
    const target: any = { UserPromptSubmit: [FRESHNESS_NUDGE_ENTRY] }
    expect(ensureGaugeReceiveHook(target, template())).toBe(true)
    expect(JSON.stringify(target.UserPromptSubmit)).toContain('prompt-freshness-nudge.py') // preserved
    expect(JSON.stringify(target.UserPromptSubmit)).toContain('channel-listener-gauge-write.py')
  })

  it('is idempotent: a second run does not duplicate the gauge hook', () => {
    const target: any = {}
    expect(ensureGaugeReceiveHook(target, template())).toBe(true)
    expect(ensureGaugeReceiveHook(target, template())).toBe(false)
    const n = (target.UserPromptSubmit as any[]).filter(
      (e: any) => JSON.stringify(e).includes('channel-listener-gauge-write.py')
    ).length
    expect(n).toBe(1)
  })

  it('returns false (no-op) when the template has no gauge hook', () => {
    const target: any = {}
    const tplNoGauge = { UserPromptSubmit: [FRESHNESS_NUDGE_ENTRY] }
    expect(ensureGaugeReceiveHook(target, tplNoGauge)).toBe(false)
    expect(target.UserPromptSubmit).toBeUndefined()
  })

  it('gauge hook absent when already present does not change existing state', () => {
    const target: any = { UserPromptSubmit: [GAUGE_RECEIVE_ENTRY] }
    const before = JSON.stringify(target)
    expect(ensureGaugeReceiveHook(target, template())).toBe(false)
    expect(JSON.stringify(target)).toBe(before)
  })
})
