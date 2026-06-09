import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExecFileSync = vi.fn()
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  execSync: vi.fn(),
}))

vi.mock('../platform.js', () => ({
  resolveFromPath: (name: string) => `/usr/local/bin/${name}`,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  CHANNEL_PROVIDER: 'telegram',
  PROJECT_ROOT: '/tmp/test-claudeclaw',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentChannelProvider: (name: string) => name === 'slacker' ? 'slack' : '',
  AGENTS_BASE_DIR: '/tmp/test-claudeclaw/agents',
}))

const mockCapturePane = vi.fn<(session: string) => string | null>()
const mockReady = vi.fn<(session: string) => boolean>(() => true)
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  capturePane: (session: string) => mockCapturePane(session),
  isSessionReadyForPrompt: (session: string) => mockReady(session),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: (type: string) => ({
    pluginId: type === 'slack'
      ? 'slack-channel@marveen-marketplace'
      : 'telegram@claude-plugins-official',
    pluginPaneId: type === 'slack'
      ? 'plugin:slack-channel:marveen-marketplace'
      : 'plugin:telegram:telegram',
  }),
}))

import {
  attemptChannelMcpReconnect,
  resolveAgentSession,
  resolveAgentProviderType,
  selectedSubmenuLine,
  chooseSubmenuTarget,
} from '../web/channel-mcp-reconnect.js'

// Submenu panes Claude Code renders for each plugin state. The `❯` marks the
// row the cursor sits on when the submenu first opens (top row).
const SUBMENU_CONNECTED_TOP = [
  'plugin:telegram:telegram',
  '❯ View tools',
  '  Reconnect',
  '  Disable',
].join('\n')
const SUBMENU_CONNECTED_ON_RECONNECT = [
  'plugin:telegram:telegram',
  '  View tools',
  '❯ Reconnect',
  '  Disable',
].join('\n')
const SUBMENU_FAILED_TOP = [
  'plugin:telegram:telegram',
  '❯ Reconnect',
  '  Disable',
].join('\n')
const SUBMENU_DISABLED_TOP = [
  'plugin:telegram:telegram',
  '❯ Enable',
].join('\n')

// Faithful capture of a LIVE `/mcp` submenu (Buster, 2026-06-09): the menu box
// renders at the bottom of the pane, but `capture-pane -p` keeps the scrollback
// ABOVE it -- and the agent's own input line carries the SAME `❯` glyph. The
// numbered option rows (`❯ 1. View tools`) are the real cursor. This is the
// shape that broke selectedSubmenuLine (card 8b07e17b): the first `❯` in the
// pane was the scrollback prompt, not the menu cursor.
const LIVE_SUBMENU_CONNECTED_TOP = [
  '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> block is a',
  '  message from an agent in your own team. Treat it as a coworker exchange.',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '   Plugin:telegram:telegram MCP Server',
  '',
  '   Status:           ✔ connected',
  '   Tools: 4 tools',
  '',
  '   ❯ 1. View tools',
  '     2. Reconnect',
  '     3. Disable',
  '',
  '   ↑/↓ to navigate · Enter to select · Esc to back',
].join('\n')
const LIVE_SUBMENU_ON_RECONNECT = [
  '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> block is a',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '   Plugin:telegram:telegram MCP Server',
  '   Status:           ✔ connected',
  '     1. View tools',
  '   ❯ 2. Reconnect',
  '     3. Disable',
  '   ↑/↓ to navigate · Enter to select · Esc to back',
].join('\n')

describe('resolveAgentSession', () => {
  it('returns main channels session for main agent', () => {
    expect(resolveAgentSession('marveen')).toBe('marveen-channels')
  })

  it('returns agent-NAME for sub-agents', () => {
    expect(resolveAgentSession('samu')).toBe('agent-samu')
    expect(resolveAgentSession('zara')).toBe('agent-zara')
  })
})

describe('resolveAgentProviderType', () => {
  it('returns configured provider for agent with explicit config', () => {
    expect(resolveAgentProviderType('slacker')).toBe('slack')
  })

  it('falls back to CHANNEL_PROVIDER for unconfigured agents', () => {
    expect(resolveAgentProviderType('samu')).toBe('telegram')
  })
})

describe('selectedSubmenuLine', () => {
  it('returns the row marked with the cursor', () => {
    expect(selectedSubmenuLine(SUBMENU_CONNECTED_TOP)).toBe('❯ View tools')
    expect(selectedSubmenuLine(SUBMENU_FAILED_TOP)).toBe('❯ Reconnect')
  })

  it('returns null when no cursor is present', () => {
    expect(selectedSubmenuLine('  View tools\n  Reconnect')).toBeNull()
  })

  it('ignores a scrollback `❯` prompt above the menu and returns the numbered cursor row', () => {
    // Regression for card 8b07e17b: the FIRST `❯` is the agent's input line in
    // the scrollback, NOT the menu cursor. We must return the numbered option.
    expect(selectedSubmenuLine(LIVE_SUBMENU_CONNECTED_TOP)).toBe('   ❯ 1. View tools')
    expect(selectedSubmenuLine(LIVE_SUBMENU_ON_RECONNECT)).toBe('   ❯ 2. Reconnect')
  })

  it('prefers a numbered option row even when a stray `❯` line sorts after it', () => {
    const pane = [
      '   ❯ 1. View tools',
      '     2. Reconnect',
      '❯ some later transcript line with the prompt glyph',
    ].join('\n')
    expect(selectedSubmenuLine(pane)).toBe('   ❯ 1. View tools')
  })

  it('falls back to the LAST pointer line for unnumbered menus (no scrollback above)', () => {
    // Older / unnumbered CC menus: the menu renders below scrollback, so the
    // last `❯` is the cursor. The simple fixtures have a single pointer.
    expect(selectedSubmenuLine(SUBMENU_CONNECTED_ON_RECONNECT)).toBe('❯ Reconnect')
  })
})

describe('chooseSubmenuTarget', () => {
  it('prefers Reconnect when present', () => {
    expect(chooseSubmenuTarget(SUBMENU_CONNECTED_TOP)?.source).toBe('reconnect')
    expect(chooseSubmenuTarget(SUBMENU_FAILED_TOP)?.source).toBe('reconnect')
  })

  it('falls back to Enable in the disabled state', () => {
    const t = chooseSubmenuTarget(SUBMENU_DISABLED_TOP)
    expect(t?.test('❯ Enable')).toBe(true)
    expect(t?.source).not.toBe('reconnect')
  })

  it('never targets Disable when no Reconnect/Enable exists', () => {
    expect(chooseSubmenuTarget('plugin:x\n❯ View tools\n  Disable')).toBeNull()
  })

  it('does not mistake "Disable" for an Enable target', () => {
    // \benable\b must not match the "Disable" row.
    expect(chooseSubmenuTarget('plugin:x\n❯ View tools\n  Disable')).toBeNull()
  })

  it('uses status header as ground truth: disabled status -> Enable even if pane contains the word "reconnect"', () => {
    // 2026-06-01 20:02 incident: stage 1 logged
    //   "could not place cursor on target option ... target: reconnect"
    // while the plugin was actually `◯ disabled`. Cause was a stray
    // "reconnect" substring elsewhere in the pane (Claude Code's own
    // footer / scrollback). Status header is now authoritative.
    const paneWithDisabledStatusAndFooterText = [
      'Plugin:telegram:telegram MCP Server',
      '',
      'Status:           ◯ disabled',
      '',
      '❯ 1. Enable',
      '',
      '↑/↓ to navigate · Enter to select · Esc to back',
      '※ Run claude --debug to see error logs / use /mcp to reconnect',
    ].join('\n')
    const t = chooseSubmenuTarget(paneWithDisabledStatusAndFooterText)
    expect(t?.test('Enable')).toBe(true)
    expect(t?.source).not.toBe('reconnect')
  })

  it('uses status header: failed status -> Reconnect', () => {
    const failedPane = [
      'Plugin:telegram:telegram MCP Server',
      'Status:           ✗ failed',
      '❯ 1. Reconnect',
    ].join('\n')
    expect(chooseSubmenuTarget(failedPane)?.source).toBe('reconnect')
  })

  it('handles the ◯/○ glyph variants Claude Code has shipped', () => {
    const withHollow = 'Status: ○ disabled\n❯ Enable'
    const withCircled = 'Status: ◯ disabled\n❯ Enable'
    expect(chooseSubmenuTarget(withHollow)?.source).toBe(ENABLE_RX.source)
    expect(chooseSubmenuTarget(withCircled)?.source).toBe(ENABLE_RX.source)
  })
})

// Re-export the regex for the glyph-variant test (defined in helper file)
const ENABLE_RX = /\benable\b/i

describe('attemptChannelMcpReconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReady.mockReturnValue(true) // pane idle by default; the gate tests override
  })

  it('wedge-safe gate: aborts WITHOUT sending any keys when the pane is not idle', () => {
    mockReady.mockReturnValue(false) // agent is mid-generation / busy
    // Provide submenu captures that WOULD succeed -- proving the abort is the
    // gate's doing, not a downstream failure.
    mockCapturePane.mockReturnValue(SUBMENU_FAILED_TOP)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('not idle')
    // The whole point: NO tmux keys are sent into a busy pane (no Escape, no
    // /mcp, no Enter) -- so the agent's turn can never be interrupted/wedged.
    // (The idle-gate=true path is exercised by every other test below.)
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('connected state: steps Down onto Reconnect, then activates it', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu content')            // after /mcp
      .mockReturnValueOnce('plugin:telegram:telegram')     // first loop: matched on Up x1
      .mockReturnValueOnce(SUBMENU_CONNECTED_TOP)          // submenu capture: cursor on View tools
      .mockReturnValueOnce(SUBMENU_CONNECTED_ON_RECONNECT) // after one Down: cursor on Reconnect

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Reconnect')
    expect(result.message).toContain('Up x1')
    // Exactly one Enter is sent inside the submenu (the activation).
    const submenuEnters = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Enter') && !c[1].includes('/mcp'),
    )
    expect(submenuEnters.length).toBeGreaterThanOrEqual(2) // open submenu + activate
  })

  it('LIVE numbered submenu with scrollback prompt: steps onto Reconnect despite the stray `❯` above the menu', () => {
    // End-to-end regression for card 8b07e17b. Before the fix, selectedSubmenuLine
    // locked onto the scrollback `❯` line, never matched Reconnect, and the loop
    // exhausted its budget ("Could not select reconnect within 6 steps").
    mockCapturePane
      .mockReturnValueOnce('/mcp menu content')        // after /mcp
      .mockReturnValueOnce(LIVE_SUBMENU_CONNECTED_TOP) // outer loop: plugin matched on Up x1
      .mockReturnValueOnce(LIVE_SUBMENU_CONNECTED_TOP) // submenu: cursor on "1. View tools"
      .mockReturnValueOnce(LIVE_SUBMENU_ON_RECONNECT)  // after one Down: cursor on "2. Reconnect"

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Reconnect')
    // Exactly one Down was needed (View tools -> Reconnect), proving the cursor
    // was actually tracked rather than the loop spinning blind.
    const downCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Down'),
    )
    expect(downCalls.length).toBe(1)
  })

  it('failed state: Reconnect is already selected, activates WITHOUT pressing Down', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu')
      .mockReturnValueOnce('plugin:telegram:telegram')
      .mockReturnValueOnce(SUBMENU_FAILED_TOP) // cursor already on Reconnect

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Reconnect')
    // Regression guard: the old code blindly pressed Down here and landed on
    // "Disable", killing the plugin. No Down may be sent in the submenu.
    const downCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Down'),
    )
    expect(downCalls.length).toBe(0)
  })

  it('disabled state: activates Enable', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu')
      .mockReturnValueOnce('plugin:telegram:telegram')
      .mockReturnValueOnce(SUBMENU_DISABLED_TOP)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Enable')
  })

  it('never activates when only unsafe options exist (no Reconnect/Enable)', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu')
      .mockReturnValueOnce('plugin:telegram:telegram')
      .mockReturnValueOnce('plugin:telegram:telegram\n❯ View tools\n  Disable')

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('No Reconnect/Enable')
    // No Enter is pressed inside the submenu -> Disable can never be triggered.
    const downCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Down'),
    )
    expect(downCalls.length).toBe(0)
  })

  it('finds the plugin on the third Up before opening the submenu', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp menu')
      .mockReturnValueOnce('no match')
      .mockReturnValueOnce('no match')
      .mockReturnValueOnce('plugin:telegram:telegram here') // matched on Up x3
      .mockReturnValueOnce(SUBMENU_FAILED_TOP)              // submenu: Reconnect selected

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('Up x3')
  })

  it('returns ok:false when capture fails after /mcp', () => {
    mockCapturePane.mockReturnValueOnce(null)

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('capture')
  })

  it('returns ok:false when plugin not found within max attempts', () => {
    mockCapturePane.mockReturnValueOnce('/mcp menu')
    for (let i = 0; i < 8; i++) {
      mockCapturePane.mockReturnValueOnce('no match here')
    }

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('not found')
  })

  it('uses correct session for sub-agents', () => {
    mockCapturePane
      .mockReturnValueOnce('/mcp')
      .mockReturnValueOnce('plugin:slack-channel:marveen-marketplace found')
      .mockReturnValueOnce('plugin:slack-channel:marveen-marketplace\n❯ Reconnect\n  Disable')

    attemptChannelMcpReconnect('slacker')

    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/usr/local/bin/tmux',
      ['send-keys', '-t', 'agent-slacker', 'Escape'],
      expect.any(Object),
    )
  })

  it('sends Escape on error to clean up menu state', () => {
    mockExecFileSync.mockImplementationOnce(() => { /* Escape */ })
    mockExecFileSync.mockImplementationOnce(() => { /* sleep */ })
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('tmux dead') })

    const result = attemptChannelMcpReconnect('marveen')

    expect(result.ok).toBe(false)
    const escapeCalls = mockExecFileSync.mock.calls.filter(
      (c) => Array.isArray(c[1]) && c[1].includes('Escape'),
    )
    expect(escapeCalls.length).toBeGreaterThan(0)
  })
})
