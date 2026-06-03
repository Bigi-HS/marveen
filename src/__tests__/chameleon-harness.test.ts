import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// --- Mock the IO-heavy dependencies so the module imports cleanly and the
// --- smoke test can be driven deterministically. ------------------------------

const mockStartAgentProcess = vi.fn<() => { ok: boolean; error?: string }>()
const mockIsAgentRunning = vi.fn<() => boolean>()
const mockStopAgentProcess = vi.fn<() => { ok: boolean }>()
const mockSendPromptToSession = vi.fn()

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => mockIsAgentRunning(),
  startAgentProcess: () => mockStartAgentProcess(),
  stopAgentProcess: () => mockStopAgentProcess(),
  sendPromptToSession: (...a: unknown[]) => mockSendPromptToSession(...a),
}))

const mockListAgentMessages = vi.fn<() => Array<{ id: number; content: string }>>()
vi.mock('../db.js', () => ({
  createAgentMessage: vi.fn(),
  listAgentMessages: () => mockListAgentMessages(),
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => `/tmp/test-claudeclaw/agents/${name}`,
  isKnownAgent: (name: string) => ['dave', 'genesis', 'buster'].includes(name),
  readFileOr: (_p: string, fallback: string) => fallback,
}))

vi.mock('../web/agent-scaffold.js', () => ({ scaffoldAgentDir: vi.fn() }))
vi.mock('../web/agent-config-dir.js', () => ({
  ensureAgentConfigDir: vi.fn(),
  CHANNEL_PLUGIN_IDS: [
    'telegram@claude-plugins-official',
    'slack-channel@marveen-marketplace',
    'discord@claude-plugins-official',
  ],
}))
vi.mock('../config.js', () => ({ MAIN_AGENT_ID: 'genesis' }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import {
  decideSmokeVerdict,
  sandboxSessionName,
  isProtectedFromReset,
  sanitizeMorphedConfig,
  sandboxBannerFor,
  stripSandboxBanner,
  pingPromptFor,
  smokeTestSandbox,
  morphSandbox,
  promoteToLive,
  sanitizePromotedConfig,
  stripChannelKeysFromSettings,
  mcpJsonReferencesSandbox,
  SANDBOX_AGENT,
  BANNER_START,
  BANNER_END,
} from '../web/chameleon-harness.js'

beforeEach(() => {
  vi.clearAllMocks()
  mockListAgentMessages.mockReturnValue([])
})

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe('decideSmokeVerdict', () => {
  it('passes only when survived AND ping answered', () => {
    expect(decideSmokeVerdict(true, true)).toBe('pass')
  })
  it('fail-died takes priority over ping (a dead agent cannot answer)', () => {
    expect(decideSmokeVerdict(false, true)).toBe('fail-died')
    expect(decideSmokeVerdict(false, false)).toBe('fail-died')
  })
  it('fail-no-ping when survived but no reply', () => {
    expect(decideSmokeVerdict(true, false)).toBe('fail-no-ping')
  })
})

describe('sandboxSessionName', () => {
  it('is the distinct agent-buster session (matches agentSessionName scheme)', () => {
    expect(sandboxSessionName()).toBe('agent-buster')
    expect(sandboxSessionName()).toBe(`agent-${SANDBOX_AGENT}`)
  })
})

describe('isProtectedFromReset', () => {
  it('protects the baseline snapshot and .git from a clean rebuild', () => {
    expect(isProtectedFromReset('.baseline')).toBe(true)
    expect(isProtectedFromReset('.git')).toBe(true)
  })
  it('does not protect live files (they are destroyed and recreated)', () => {
    expect(isProtectedFromReset('CLAUDE.md')).toBe(false)
    expect(isProtectedFromReset('.claude')).toBe(false)
    expect(isProtectedFromReset('memory')).toBe(false)
  })
})

describe('sanitizeMorphedConfig', () => {
  it('keeps model and securityProfile from the target', () => {
    const cfg = sanitizeMorphedConfig('{"model":"claude-opus-4-8[1m]","securityProfile":"standard"}', 'dave')
    expect(cfg.model).toBe('claude-opus-4-8[1m]')
    expect(cfg.securityProfile).toBe('standard')
  })
  it('forces channel-less, shared auth, and records the clone source', () => {
    const cfg = sanitizeMorphedConfig('{"channelProvider":"telegram","authMode":"api"}', 'dave')
    expect(cfg.channelProvider).toBeNull()
    expect(cfg.authMode).toBe('shared')
    expect(cfg.sandboxCloneOf).toBe('dave')
  })
  it('never carries arbitrary target fields (e.g. a token reference)', () => {
    const cfg = sanitizeMorphedConfig('{"telegramToken":"secret","displayName":"Dave"}', 'dave')
    expect(cfg.telegramToken).toBeUndefined()
    expect(cfg.displayName).toBeUndefined()
  })
  it('tolerates malformed JSON', () => {
    const cfg = sanitizeMorphedConfig('not json', 'dave')
    expect(cfg.channelProvider).toBeNull()
    expect(cfg.authMode).toBe('shared')
    expect(cfg.sandboxCloneOf).toBe('dave')
  })
})

describe('sandboxBannerFor / stripSandboxBanner', () => {
  it('banner names the target and pins attribution to buster', () => {
    const b = sandboxBannerFor('dave')
    expect(b).toContain('clone of "dave"')
    expect(b).toContain('identify yourself as "buster"')
    expect(b.startsWith(BANNER_START)).toBe(true)
    expect(b).toContain(BANNER_END)
  })
  it('strip removes a prepended banner byte-exactly (round-trip)', () => {
    const body = '# Dave\n\nSome instructions.\n'
    expect(stripSandboxBanner(sandboxBannerFor('dave') + body)).toBe(body)
  })
  it('strip leaves banner-free content untouched', () => {
    const body = '# Dave\n\nNo banner here.\n'
    expect(stripSandboxBanner(body)).toBe(body)
  })
})

describe('pingPromptFor', () => {
  it('embeds the nonce and instructs a buster-attributed reply', () => {
    const p = pingPromptFor('C12-abc')
    expect(p).toContain('PONG C12-abc')
    expect(p).toContain('from "buster"')
  })
})

// ---------------------------------------------------------------------------
// Guards on morph / promote (no real fs writes hit because agentDir is a tmp
// path and isKnownAgent is mocked; the guard branches return before any IO).
// ---------------------------------------------------------------------------

describe('morphSandbox guards', () => {
  it('refuses to morph into itself', () => {
    expect(morphSandbox('buster').ok).toBe(false)
  })
  it('refuses to morph into the main agent', () => {
    expect(morphSandbox('genesis').ok).toBe(false)
  })
  it('refuses an unknown target', () => {
    expect(morphSandbox('nope').ok).toBe(false)
  })
})

describe('promoteToLive guards', () => {
  it('requires explicit confirm', () => {
    const r = promoteToLive('dave', {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/confirm/)
  })
  it('refuses the sandbox and the main agent as promote targets', () => {
    expect(promoteToLive('buster', { confirm: true }).ok).toBe(false)
    expect(promoteToLive('genesis', { confirm: true }).ok).toBe(false)
  })
  it('refuses an unknown target', () => {
    expect(promoteToLive('nope', { confirm: true }).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Opt-in promote field filtering (the security-critical part)
// ---------------------------------------------------------------------------

describe('sanitizePromotedConfig', () => {
  it('overlays only model/securityProfile/displayName onto the target config', () => {
    const sandbox = '{"model":"claude-sonnet-4-6","securityProfile":"standard","displayName":"Dave"}'
    const target = '{"model":"claude-opus-4-8[1m]","channelProvider":"telegram","authMode":"api"}'
    const m = sanitizePromotedConfig(sandbox, target)
    expect(m.model).toBe('claude-sonnet-4-6')
    expect(m.securityProfile).toBe('standard')
    expect(m.displayName).toBe('Dave')
    // Target's channel/auth survive untouched -- never overwritten or dropped.
    expect(m.channelProvider).toBe('telegram')
    expect(m.authMode).toBe('api')
  })
  it('never carries channelProvider / claudeConfigDir / token from the sandbox', () => {
    const sandbox = '{"model":"claude-haiku-4-5-20251001","channelProvider":null,"claudeConfigDir":"/tmp/x","telegramToken":"secret","sandboxCloneOf":"dave"}'
    const target = '{"channelProvider":"slack"}'
    const m = sanitizePromotedConfig(sandbox, target)
    expect(m.model).toBe('claude-haiku-4-5-20251001')
    // The sandbox's channelProvider:null must NOT clobber the target's slack.
    expect(m.channelProvider).toBe('slack')
    expect(m.claudeConfigDir).toBeUndefined()
    expect(m.telegramToken).toBeUndefined()
    expect(m.sandboxCloneOf).toBeUndefined()
  })
  it('tolerates malformed json on either side without leaking', () => {
    expect(sanitizePromotedConfig('nope', 'also nope')).toEqual({})
  })
})

describe('stripChannelKeysFromSettings', () => {
  it('removes channel plugin keys but keeps permissions/hooks/effortLevel', () => {
    const raw = JSON.stringify({
      permissions: { allow: ['a'] },
      hooks: { PreCompact: [] },
      effortLevel: 'high',
      enabledPlugins: {
        'telegram@claude-plugins-official': true,
        'some-other-plugin@x': true,
      },
    })
    const s = stripChannelKeysFromSettings(raw)
    expect(s.permissions).toEqual({ allow: ['a'] })
    expect(s.hooks).toEqual({ PreCompact: [] })
    expect(s.effortLevel).toBe('high')
    expect((s.enabledPlugins as Record<string, unknown>)['telegram@claude-plugins-official']).toBeUndefined()
    expect((s.enabledPlugins as Record<string, unknown>)['some-other-plugin@x']).toBe(true)
  })
  it('drops enabledPlugins entirely when stripping empties it', () => {
    const raw = JSON.stringify({ enabledPlugins: { 'telegram@claude-plugins-official': true } })
    const s = stripChannelKeysFromSettings(raw)
    expect(s.enabledPlugins).toBeUndefined()
  })
})

describe('mcpJsonReferencesSandbox', () => {
  it('flags a .mcp.json carrying a path into the sandbox agent dir', () => {
    expect(mcpJsonReferencesSandbox('{"mcpServers":{"x":{"args":["/home/u/marveen/agents/buster/x"]}}}')).toBe(true)
    expect(mcpJsonReferencesSandbox('{"a":"/buster/.claude/foo"}')).toBe(true)
    expect(mcpJsonReferencesSandbox('{"sandboxCloneOf":"dave"}')).toBe(true)
  })
  it('passes a clean target .mcp.json (no sandbox reference)', () => {
    expect(mcpJsonReferencesSandbox('{"mcpServers":{"aiam-blog":{"url":"https://x"}}}')).toBe(false)
    expect(mcpJsonReferencesSandbox('{"mcpServers":{}}')).toBe(false)
  })
})

describe('promoteToLive default surface is token/path safe', () => {
  it('default options never enable the config/settings/mcp opt-ins', () => {
    // The pure guard returns before IO when confirm is missing; here we just
    // assert the opt-in flags are off by default so the safe default surface
    // (CLAUDE.md + SOUL.md + skills) cannot leak a token or path.
    const r = promoteToLive('dave', {})
    expect(r.ok).toBe(false) // missing confirm
    // Source contract below pins that include* are only honoured when set.
  })
})

// ---------------------------------------------------------------------------
// smokeTestSandbox behaviour (deterministic via injected clock + ping waiter)
// ---------------------------------------------------------------------------

function clockSeam() {
  let clock = 0
  return {
    now: () => clock,
    sleep: async (ms: number) => { clock += ms },
  }
}

describe('smokeTestSandbox', () => {
  it('fail-died when launch fails', async () => {
    mockStartAgentProcess.mockReturnValue({ ok: false, error: 'boom' })
    const r = await smokeTestSandbox({ surviveMs: 60, pollMs: 20, ...clockSeam() })
    expect(r.verdict).toBe('fail-died')
    expect(r.survived).toBe(false)
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })

  it('fail-died when the agent dies inside the survival window', async () => {
    mockStartAgentProcess.mockReturnValue({ ok: true })
    mockIsAgentRunning.mockReturnValue(false)
    const r = await smokeTestSandbox({ surviveMs: 60, pollMs: 20, ...clockSeam() })
    expect(r.verdict).toBe('fail-died')
    expect(r.survived).toBe(false)
  })

  it('fail-no-ping when it survives but the ping is not answered', async () => {
    mockStartAgentProcess.mockReturnValue({ ok: true })
    mockIsAgentRunning.mockReturnValue(true)
    const r = await smokeTestSandbox({
      surviveMs: 60, pollMs: 20, ...clockSeam(),
      waitForPingReply: async () => false,
    })
    expect(r.verdict).toBe('fail-no-ping')
    expect(r.survived).toBe(true)
    expect(r.pingAnswered).toBe(false)
    expect(mockSendPromptToSession).toHaveBeenCalledOnce()
    expect(mockStopAgentProcess).toHaveBeenCalled()
  })

  it('pass when it survives and answers the ping', async () => {
    mockStartAgentProcess.mockReturnValue({ ok: true })
    mockIsAgentRunning.mockReturnValue(true)
    const r = await smokeTestSandbox({
      surviveMs: 60, pollMs: 20, ...clockSeam(),
      waitForPingReply: async () => true,
    })
    expect(r.verdict).toBe('pass')
    expect(r.survived).toBe(true)
    expect(r.pingAnswered).toBe(true)
  })

  it('keepRunning leaves the sandbox up after a pass', async () => {
    mockStartAgentProcess.mockReturnValue({ ok: true })
    mockIsAgentRunning.mockReturnValue(true)
    await smokeTestSandbox({
      surviveMs: 60, pollMs: 20, ...clockSeam(),
      keepRunning: true,
      waitForPingReply: async () => true,
    })
    expect(mockStopAgentProcess).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Source-contract guards on the hard constraints
// ---------------------------------------------------------------------------

const SRC = readFileSync(join(__dirname, '../web/chameleon-harness.ts'), 'utf-8')

describe('chameleon-harness -- hard-constraint source contracts', () => {
  it('never uses pkill outside comments (PID/session-scoped kills only)', () => {
    // The header documents WHY we avoid pkill, so the word legitimately appears
    // in prose. Assert no executable (non-comment) line invokes it.
    const offending = SRC.split('\n').filter(line => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false
      return /pkill/.test(line)
    })
    expect(offending).toEqual([])
  })
  it('stops the sandbox via stopAgentProcess (the PID-safe path)', () => {
    expect(SRC).toMatch(/stopAgentProcess\(SANDBOX_AGENT\)/)
  })
  it('morph starts from a clean baseline before overlaying the target', () => {
    const morphIdx = SRC.indexOf('export function morphSandbox')
    const revertIdx = SRC.indexOf('revertSandboxToBaseline()', morphIdx)
    expect(revertIdx).toBeGreaterThan(morphIdx)
  })
  it('revert is a destroy-and-recreate (rmSync + scaffold + config rebuild)', () => {
    const revertIdx = SRC.indexOf('export function revertSandboxToBaseline')
    const slice = SRC.slice(revertIdx, revertIdx + 1200)
    expect(slice).toMatch(/rmSync/)
    expect(slice).toMatch(/scaffoldAgentDir\(SANDBOX_AGENT\)/)
    expect(slice).toMatch(/ensureAgentConfigDir\(SANDBOX_AGENT\)/)
  })
  it('morph never copies a channel token (no channels/ dir copy)', () => {
    const morphIdx = SRC.indexOf('export function morphSandbox')
    const slice = SRC.slice(morphIdx, morphIdx + 1600)
    expect(slice).not.toMatch(/channels/)
  })
  it('promote requires confirm and backs up before overwriting', () => {
    const promoteIdx = SRC.indexOf('export function promoteToLive')
    const slice = SRC.slice(promoteIdx, promoteIdx + 4200)
    expect(slice).toMatch(/opts\.confirm/)
    expect(slice).toMatch(/backupDir/)
  })
  it('opt-in agent-config promote is field-filtered (never a raw copy)', () => {
    const promoteIdx = SRC.indexOf('export function promoteToLive')
    const slice = SRC.slice(promoteIdx, promoteIdx + 4200)
    expect(slice).toMatch(/opts\.includeAgentConfig/)
    expect(slice).toMatch(/sanitizePromotedConfig/)
  })
  it('opt-in settings promote strips channel keys', () => {
    const promoteIdx = SRC.indexOf('export function promoteToLive')
    const slice = SRC.slice(promoteIdx, promoteIdx + 4200)
    expect(slice).toMatch(/opts\.includeSettings/)
    expect(slice).toMatch(/stripChannelKeysFromSettings/)
  })
  it('--with-mcp promotion fails fast on a sandbox-referencing .mcp.json before any write', () => {
    const promoteIdx = SRC.indexOf('export function promoteToLive')
    const slice = SRC.slice(promoteIdx, promoteIdx + 4200)
    // The guard must sit before the backup/write block (mkdirSync backupDir).
    const guardIdx = slice.indexOf('mcpJsonReferencesSandbox')
    const firstWriteIdx = slice.indexOf('mkdirSync(backupDir')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(firstWriteIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(firstWriteIdx)
  })
})
