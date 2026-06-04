import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isValidModelId,
  evaluatePreflight,
  type PreflightFacts,
} from '../web/agent-preflight.js'

// A baseline, fully-healthy facts struct; individual tests flip one field.
function healthyFacts(over: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    usesCanonicalConfigDir: true,
    claudeJsonExists: true,
    claudeJsonIsSymlink: false,
    hasToken: false,
    channelIntentEnabled: false,
    modelId: 'claude-sonnet-4-6',
    modelValid: true,
    tmuxOnPath: true,
    claudeOnPath: true,
    ...over,
  }
}

const codes = (f: PreflightFacts) => evaluatePreflight(f).map(x => x.code)
const level = (f: PreflightFacts, code: string) => evaluatePreflight(f).find(x => x.code === code)?.level

describe('isValidModelId', () => {
  it('accepts real model ids incl. the 1m suffix and ollama tags', () => {
    expect(isValidModelId('claude-sonnet-4-6')).toBe(true)
    expect(isValidModelId('claude-opus-4-8[1m]')).toBe(true)
    expect(isValidModelId('claude-haiku-4-5-20251001')).toBe(true)
    expect(isValidModelId('qwen2.5:7b')).toBe(true)
  })
  it('rejects empty / whitespace / shell-significant ids', () => {
    expect(isValidModelId('')).toBe(false)
    expect(isValidModelId('   ')).toBe(false)
    expect(isValidModelId('bad model')).toBe(false)
    expect(isValidModelId("model';rm -rf")).toBe(false)
    expect(isValidModelId('model$(x)')).toBe(false)
  })
})

describe('evaluatePreflight', () => {
  it('healthy facts produce no findings', () => {
    expect(evaluatePreflight(healthyFacts())).toEqual([])
  })

  it('missing binaries are errors', () => {
    expect(level(healthyFacts({ tmuxOnPath: false }), 'tmux-missing')).toBe('error')
    expect(level(healthyFacts({ claudeOnPath: false }), 'claude-missing')).toBe('error')
  })

  it('invalid model id is an error', () => {
    expect(level(healthyFacts({ modelValid: false, modelId: 'bad id' }), 'model-invalid')).toBe('error')
  })

  it('symlinked config-dir .claude.json is an error (lock-death risk)', () => {
    expect(level(healthyFacts({ claudeJsonIsSymlink: true }), 'claudejson-symlink')).toBe('error')
  })

  it('missing config-dir .claude.json is only a warn (auto-seeded)', () => {
    expect(level(healthyFacts({ claudeJsonExists: false }), 'claudejson-missing')).toBe('warn')
  })

  it('skips the .claude.json checks when a custom config dir is used', () => {
    const f = healthyFacts({ usesCanonicalConfigDir: false, claudeJsonIsSymlink: true, claudeJsonExists: false })
    expect(codes(f)).not.toContain('claudejson-symlink')
    expect(codes(f)).not.toContain('claudejson-missing')
  })

  it('token present without intent is a warn (the death-loop config)', () => {
    expect(level(healthyFacts({ hasToken: true, channelIntentEnabled: false }), 'channel-token-without-intent')).toBe('warn')
  })

  it('intent without token is a warn', () => {
    expect(level(healthyFacts({ hasToken: false, channelIntentEnabled: true }), 'channel-intent-without-token')).toBe('warn')
  })

  it('token AND intent together is unambiguous (no channel finding)', () => {
    const c = codes(healthyFacts({ hasToken: true, channelIntentEnabled: true }))
    expect(c).not.toContain('channel-token-without-intent')
    expect(c).not.toContain('channel-intent-without-token')
  })

  it('errors and warns coexist; only errors are error-level', () => {
    const f = healthyFacts({ tmuxOnPath: false, hasToken: true, channelIntentEnabled: false })
    const findings = evaluatePreflight(f)
    expect(findings.some(x => x.code === 'tmux-missing' && x.level === 'error')).toBe(true)
    expect(findings.some(x => x.code === 'channel-token-without-intent' && x.level === 'warn')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Source contracts
// ---------------------------------------------------------------------------

const PREFLIGHT_SRC = readFileSync(join(__dirname, '../web/agent-preflight.ts'), 'utf-8')
const PROCESS_SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

describe('agent-preflight -- source contracts', () => {
  it('runPreflight reports not-ok only on error-level findings', () => {
    expect(PREFLIGHT_SRC).toMatch(/findings\.some\(x => x\.level === 'error'\)/)
  })
  it('does not import agent-process (no launch import cycle)', () => {
    expect(PREFLIGHT_SRC).not.toMatch(/from '\.\/agent-process/)
  })
  it('channel-intent check reads config-dir settings.json enabledPlugins', () => {
    expect(PREFLIGHT_SRC).toMatch(/\.claude-config/)
    expect(PREFLIGHT_SRC).toMatch(/enabledPlugins/)
  })
})

describe('startAgentProcess -- preflight wiring', () => {
  it('runs preflight and aborts the launch on a not-ok result', () => {
    const idx = PROCESS_SRC.indexOf('export function startAgentProcess')
    const slice = PROCESS_SRC.slice(idx, idx + 900)
    expect(slice).toMatch(/runPreflight\(name\)/)
    expect(slice).toMatch(/if \(!preflight\.ok\)/)
    expect(slice).toMatch(/preflight failed/)
  })
  it('runs the preflight before the tmux new-session launch', () => {
    const preflightIdx = PROCESS_SRC.indexOf('runPreflight(name)')
    // The launcher spawns via execFileSync(TMUX, ['new-session', '-d', '-s', ...])
    // (argv form, not an interpolated shell string), so match the array element.
    const launchIdx = PROCESS_SRC.indexOf("'new-session'")
    expect(preflightIdx).toBeGreaterThan(-1)
    expect(launchIdx).toBeGreaterThan(preflightIdx)
  })
})
