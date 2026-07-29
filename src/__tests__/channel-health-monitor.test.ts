import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
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
  listAgentNames: () => ['samu'],
  readAgentChannelProviderSafe: () => ({ provider: 'telegram', misconfigured: false }),
  AGENTS_BASE_DIR: '/tmp/test-claudeclaw/agents',
}))

const mockCapturePane = vi.fn<(session: string) => string | null>()
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: (name: string) => name === 'samu',
  capturePane: (session: string) => mockCapturePane(session),
  agentSessionName: (name: string) => `agent-${name}`,
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

const mockReconnect = vi.fn()
vi.mock('../web/channel-mcp-reconnect.js', () => ({
  attemptChannelMcpReconnect: (name: string) => mockReconnect(name),
  resolveAgentSession: (name: string) => name === 'marveen' ? 'marveen-channels' : `agent-${name}`,
  resolveAgentProviderType: () => 'telegram' as const,
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    pluginId: 'telegram@claude-plugins-official',
    pluginPaneId: 'plugin:telegram:telegram',
  }),
}))

const mockCreateAgentMessage = vi.fn()
vi.mock('../db.js', () => ({
  createAgentMessage: (...args: unknown[]) => mockCreateAgentMessage(...args),
}))

import {
  getChannelHealth,
  startChannelHealthMonitor,
  recoverPipeFromPane,
  decideDeferralEscalation,
} from '../web/channel-health-monitor.js'
import type { ProcEnvScan } from '../web/channel-poller-reap.js'

describe('getChannelHealth', () => {
  it('returns healthy when no reconnect state exists', () => {
    const health = getChannelHealth('unknown-agent')
    expect(health.healthy).toBe(true)
    expect(health.reconnectAttempts).toBe(0)
    expect(health.lastAttemptAt).toBeNull()
  })
})

describe('startChannelHealthMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a timer handle', () => {
    const timer = startChannelHealthMonitor()
    expect(timer).toBeDefined()
    clearInterval(timer)
  })

  it('does not reconnect when pane shows no failure', () => {
    const timer = startChannelHealthMonitor()
    mockCapturePane.mockReturnValue('normal pane content with plugin:telegram:telegram active')

    vi.advanceTimersByTime(46_000)

    expect(mockReconnect).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('triggers reconnect when pane shows plugin failure', () => {
    mockReconnect.mockReturnValue({ ok: false, message: 'test' })
    const timer = startChannelHealthMonitor()
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed\nsome other output',
    )

    vi.advanceTimersByTime(46_000)

    expect(mockReconnect).toHaveBeenCalled()
    clearInterval(timer)
  })
})

// recoverPipeFromPane is the shared seam the busy->idle idle-trigger calls
// directly with an already-captured pane (card 667281e4).
describe('recoverPipeFromPane (shared seam)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reconnects when given a ✘-failing pane (FN at the recover boundary)', () => {
    // Fresh agent name: reconnectState is module-level and persists across tests,
    // so a name with no prior backoff state isolates this assertion.
    mockReconnect.mockReturnValue({ ok: true })
    recoverPipeFromPane('seam-test-agent', 'plugin:telegram:telegram  ✘ failed', {} as ProcEnvScan)
    expect(mockReconnect).toHaveBeenCalledWith('seam-test-agent')
  })
})

describe('decideDeferralEscalation (stuck-busy operator alert)', () => {
  const T = { threshold: 5, cooldownMs: 30 * 60 * 1000 }
  const START = { consecutiveDeferrals: 0, lastEscalatedAtMs: null }

  it('does not escalate below the threshold, but counts the deferral', () => {
    const d = decideDeferralEscalation({ deferred: true, prev: START, nowMs: 1000 }, T)
    expect(d.escalate).toBe(false)
    expect(d.next.consecutiveDeferrals).toBe(1)
    expect(d.next.lastEscalatedAtMs).toBeNull()
  })

  it('escalates exactly once when the threshold is reached', () => {
    const prev = { consecutiveDeferrals: 4, lastEscalatedAtMs: null }
    const d = decideDeferralEscalation({ deferred: true, prev, nowMs: 5000 }, T)
    expect(d.escalate).toBe(true)
    expect(d.next.consecutiveDeferrals).toBe(5)
    expect(d.next.lastEscalatedAtMs).toBe(5000)
  })

  it('suppresses a re-alert inside the cooldown while still stuck', () => {
    const prev = { consecutiveDeferrals: 5, lastEscalatedAtMs: 5000 }
    const d = decideDeferralEscalation({ deferred: true, prev, nowMs: 5000 + 60_000 }, T)
    expect(d.escalate).toBe(false)
    expect(d.next.consecutiveDeferrals).toBe(6)
    expect(d.next.lastEscalatedAtMs).toBe(5000) // unchanged
  })

  it('re-alerts once the cooldown has elapsed and it is still stuck', () => {
    const prev = { consecutiveDeferrals: 9, lastEscalatedAtMs: 5000 }
    const d = decideDeferralEscalation({ deferred: true, prev, nowMs: 5000 + T.cooldownMs }, T)
    expect(d.escalate).toBe(true)
    expect(d.next.lastEscalatedAtMs).toBe(5000 + T.cooldownMs)
  })

  it('a non-deferred outcome (recovered / real drive) resets the spell', () => {
    const prev = { consecutiveDeferrals: 4, lastEscalatedAtMs: null }
    const d = decideDeferralEscalation({ deferred: false, prev, nowMs: 9000 }, T)
    expect(d.escalate).toBe(false)
    expect(d.next.consecutiveDeferrals).toBe(0)
    expect(d.next.lastEscalatedAtMs).toBeNull()
  })
})

describe('recoverPipeFromPane: stuck-busy deferral wiring', () => {
  beforeEach(() => vi.clearAllMocks())

  const FAILING_PANE = 'plugin:telegram:telegram  ✘ failed'
  const CYCLE_MS = 31_000 // > DEFERRAL_RETRY_MS so each call passes the backoff gate

  it('escalates to the operator (marveen) after 5 consecutive busy deferrals, once', () => {
    mockReconnect.mockReturnValue({ ok: false, deferred: true, message: 'Pane not idle' })
    const agent = 'stuck-busy-agent'
    let t = 1_000_000
    for (let i = 0; i < 6; i++) {
      recoverPipeFromPane(agent, FAILING_PANE, {} as ProcEnvScan, t)
      t += CYCLE_MS
    }
    // Fired exactly once at the 5th deferral (6th cycle is inside cooldown).
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1)
    const [from, to, content, , priority] = mockCreateAgentMessage.mock.calls[0]
    expect(from).toBe('channel-health-monitor')
    expect(to).toBe('marveen') // operator channel, not a direct Boss DM
    expect(priority).toBe('high')
    expect(String(content)).toContain(agent)
  })

  it('does not escalate while the pane keeps deferring below threshold', () => {
    mockReconnect.mockReturnValue({ ok: false, deferred: true, message: 'Pane not idle' })
    const agent = 'briefly-busy-agent'
    let t = 2_000_000
    for (let i = 0; i < 4; i++) {
      recoverPipeFromPane(agent, FAILING_PANE, {} as ProcEnvScan, t)
      t += CYCLE_MS
    }
    expect(mockCreateAgentMessage).not.toHaveBeenCalled()
  })

  it('a deferral does NOT exhaust the reconnect-retry budget (agent still recovers later)', () => {
    // Ten busy deferrals then an idle cycle where /mcp finally drives: because
    // deferrals never advanced `attempts`, the reconnect still runs (not stuck in
    // the MAX_RETRIES 30-min cooldown).
    const agent = 'eventually-idle-agent'
    let t = 3_000_000
    mockReconnect.mockReturnValue({ ok: false, deferred: true, message: 'Pane not idle' })
    for (let i = 0; i < 10; i++) {
      recoverPipeFromPane(agent, FAILING_PANE, {} as ProcEnvScan, t)
      t += CYCLE_MS
    }
    mockReconnect.mockClear()
    mockReconnect.mockReturnValue({ ok: true, message: 'Activated Reconnect' })
    recoverPipeFromPane(agent, FAILING_PANE, {} as ProcEnvScan, t)
    expect(mockReconnect).toHaveBeenCalledWith(agent) // the drive actually ran
  })
})
