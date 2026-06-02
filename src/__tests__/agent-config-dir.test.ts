import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  lstatSync,
  readlinkSync,
  readFileSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildAgentConfigDir, type BuildAgentConfigDirParams } from '../web/agent-config-dir.js'

// Isolated sandbox: a fake ~/.claude donor tree + a fake ~/.claude.json, built
// fresh per test so nothing touches the real host config. Nothing here spawns
// tmux or a claude process -- pure filesystem behaviour of buildAgentConfigDir.
let root: string
let realClaudeDir: string
let realClaudeJsonPath: string
let configDir: string
let agentCwd: string
const PROJECT_ROOT = '/fake/project-root'

function params(over: Partial<BuildAgentConfigDirParams> = {}): BuildAgentConfigDirParams {
  return {
    configDir,
    agentCwd,
    realClaudeDir,
    realClaudeJsonPath,
    projectRoot: PROJECT_ROOT,
    ...over,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-config-dir-'))
  realClaudeDir = join(root, '.claude')
  realClaudeJsonPath = join(root, '.claude.json')
  configDir = join(root, 'agents', 'x', '.claude-config')
  agentCwd = join(root, 'agents', 'x')

  // Donor ~/.claude tree: a credentials file, two dirs, settings.json, plus
  // a noise file that must NOT be symlinked.
  mkdirSync(realClaudeDir, { recursive: true })
  writeFileSync(join(realClaudeDir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}')
  mkdirSync(join(realClaudeDir, 'projects'))
  mkdirSync(join(realClaudeDir, 'plugins'))
  writeFileSync(join(realClaudeDir, '.lock'), '')
  writeFileSync(
    join(realClaudeDir, 'settings.json'),
    JSON.stringify({
      theme: 'dark',
      extraKnownMarketplaces: { 'claude-plugins-official': { source: 'gh' } },
      enabledPlugins: { 'telegram@claude-plugins-official': true, 'some-other@x': true },
    }),
  )

  // Donor ~/.claude.json with a projects map keyed by the project root.
  writeFileSync(
    realClaudeJsonPath,
    JSON.stringify({
      firstStartTime: '2026-01-01',
      projects: {
        [PROJECT_ROOT]: { mcpServers: { gmail: {} }, hasTrustDialogAccepted: true },
      },
    }),
  )
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('buildAgentConfigDir -- symlink tree', () => {
  it('creates the config dir and symlinks shared entries back to ~/.claude', () => {
    buildAgentConfigDir(params())
    expect(existsSync(configDir)).toBe(true)

    for (const entry of ['.credentials.json', 'projects', 'plugins']) {
      const link = join(configDir, entry)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(join(realClaudeDir, entry))
    }
  })

  it('does NOT symlink noise/lock files', () => {
    buildAgentConfigDir(params())
    expect(existsSync(join(configDir, '.lock'))).toBe(false)
  })

  it('replaces a stale non-symlink entry with a proper symlink', () => {
    mkdirSync(configDir, { recursive: true })
    // Pre-existing stale regular file where a symlink should be.
    writeFileSync(join(configDir, '.credentials.json'), 'stale')
    buildAgentConfigDir(params())
    const link = join(configDir, '.credentials.json')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(realClaudeDir, '.credentials.json'))
  })
})

describe('buildAgentConfigDir -- private .claude.json (the lock fix)', () => {
  it('materialises .claude.json as a regular-file COPY, not a symlink', () => {
    buildAgentConfigDir(params())
    const p = join(configDir, '.claude.json')
    expect(existsSync(p)).toBe(true)
    expect(lstatSync(p).isSymbolicLink()).toBe(false)
  })

  it('duplicates projects[projectRoot] under projects[agentCwd]', () => {
    buildAgentConfigDir(params())
    const parsed = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf-8'))
    expect(parsed.projects[agentCwd]).toEqual(parsed.projects[PROJECT_ROOT])
    expect(parsed.projects[agentCwd].mcpServers.gmail).toBeDefined()
  })

  it('writes .claude.json with mode 0600', () => {
    buildAgentConfigDir(params())
    const mode = statSync(join(configDir, '.claude.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('seeds .claude.json only if missing -- does not clobber accumulated state', () => {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ mine: true }))
    buildAgentConfigDir(params())
    const parsed = JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf-8'))
    expect(parsed.mine).toBe(true)
    expect(parsed.projects).toBeUndefined()
  })

  it('does not fail when the host ~/.claude.json is absent', () => {
    rmSync(realClaudeJsonPath)
    expect(() => buildAgentConfigDir(params())).not.toThrow()
    expect(existsSync(join(configDir, '.claude.json'))).toBe(false)
  })
})

describe('buildAgentConfigDir -- channel-neutral settings.json', () => {
  it('owns settings.json as a regular file (not a symlink)', () => {
    buildAgentConfigDir(params())
    const p = join(configDir, 'settings.json')
    expect(existsSync(p)).toBe(true)
    expect(lstatSync(p).isSymbolicLink()).toBe(false)
  })

  it('strips channel-plugin keys from the seeded settings.json', () => {
    buildAgentConfigDir(params())
    const parsed = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8'))
    // The telegram channel key is gone; the non-channel plugin is preserved.
    expect(parsed.enabledPlugins?.['telegram@claude-plugins-official']).toBeUndefined()
    expect(parsed.enabledPlugins?.['some-other@x']).toBe(true)
  })

  it('preserves non-channel settings (theme, marketplaces)', () => {
    buildAgentConfigDir(params())
    const parsed = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8'))
    expect(parsed.theme).toBe('dark')
    expect(parsed.extraKnownMarketplaces).toBeDefined()
  })

  it('cleans up stale channel state in an existing owned settings.json (the sibling bug)', () => {
    mkdirSync(configDir, { recursive: true })
    // Mirrors dave's manual channel-less setup: telegram explicitly false.
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        enabledPlugins: {
          'telegram@claude-plugins-official': false,
          'slack-channel@marveen-marketplace': false,
          'discord@claude-plugins-official': false,
        },
      }),
    )
    buildAgentConfigDir(params())
    const parsed = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8'))
    // All channel keys stripped; map removed entirely once empty.
    expect(parsed.enabledPlugins).toBeUndefined()
    expect(parsed.theme).toBe('dark')
  })

  it('removes a settings.json that was a symlink and re-owns it', () => {
    mkdirSync(configDir, { recursive: true })
    symlinkSync(join(realClaudeDir, 'settings.json'), join(configDir, 'settings.json'))
    buildAgentConfigDir(params())
    const p = join(configDir, 'settings.json')
    expect(lstatSync(p).isSymbolicLink()).toBe(false)
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    expect(parsed.enabledPlugins?.['telegram@claude-plugins-official']).toBeUndefined()
  })
})

describe('buildAgentConfigDir -- idempotency', () => {
  it('is safe to call twice and keeps the symlink + private files intact', () => {
    buildAgentConfigDir(params())
    expect(() => buildAgentConfigDir(params())).not.toThrow()
    expect(lstatSync(join(configDir, 'projects')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(configDir, '.claude.json')).isSymbolicLink()).toBe(false)
    expect(lstatSync(join(configDir, 'settings.json')).isSymbolicLink()).toBe(false)
  })
})
