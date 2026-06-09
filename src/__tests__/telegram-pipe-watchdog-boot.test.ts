import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Boot-path recovery (pipe-RCA #6, card b322514d): probeOrchestratorPipe +
// recoverOrchestratorPipeOnce. Isolated mocks so we never touch real tmux/fs/
// network. Fake timers skip the 2s inter-probe gaps.

const mockPresence = vi.fn<() => boolean | null>(() => true)
const mockConflict = vi.fn<() => Promise<{ conflicted: boolean; status: number }>>()
const mockReconnect = vi.fn<() => { ok: boolean; message: string }>(() => ({ ok: true, message: 'Activated Reconnect' }))

vi.mock('node:fs', () => ({
  existsSync: () => false,
  readFileSync: () => { throw new Error('no state file in test') },
  writeFileSync: () => { /* no-op */ },
  appendFileSync: () => { /* no-op */ },
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../config.js', () => ({ MAIN_AGENT_ID: 'marveen' }))
vi.mock('../channel-provider.js', () => ({
  channelStateDir: () => '/tmp/test-chan/telegram',
  readChannelToken: () => 'sk-test-bot-token',
}))
vi.mock('../web/channel-conflict-probe.js', () => ({
  probeTelegramConflict: () => mockConflict(),
}))
vi.mock('../web/channel-poller-reap.js', () => ({
  probeChannelPollerPresence: () => mockPresence(),
}))
vi.mock('../web/channel-mcp-reconnect.js', () => ({
  attemptChannelMcpReconnect: () => mockReconnect(),
}))

import { recoverOrchestratorPipeOnce, probeOrchestratorPipe } from '../web/telegram-pipe-watchdog.js'

const NOW = 1_700_000_000_000

describe('probeOrchestratorPipe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockPresence.mockReturnValue(true)
  })
  afterEach(() => vi.useRealTimers())

  it('stops probing early on a 409 (alive) -- a single conflict probe', async () => {
    mockConflict.mockResolvedValue({ conflicted: true, status: 409 })
    const p = probeOrchestratorPipe('tok')
    await vi.runAllTimersAsync()
    const facts = await p
    expect(facts.conflicted).toBe(true)
    expect(facts.probeStatus).toBe(409)
    expect(mockConflict).toHaveBeenCalledTimes(1)
  })

  it('aggregates an all-200 window to a slot-free (dead) status across the retries', async () => {
    mockConflict.mockResolvedValue({ conflicted: false, status: 200 })
    const p = probeOrchestratorPipe('tok')
    await vi.runAllTimersAsync()
    const facts = await p
    expect(facts.conflicted).toBe(false)
    expect(facts.probeStatus).toBe(200)
    expect(mockConflict).toHaveBeenCalledTimes(3)
  })

  it('skips the conflict probe entirely when there is no token', async () => {
    const p = probeOrchestratorPipe(null)
    await vi.runAllTimersAsync()
    const facts = await p
    expect(mockConflict).not.toHaveBeenCalled()
    expect(facts.probeStatus).toBe(0)
  })
})

describe('recoverOrchestratorPipeOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockPresence.mockReturnValue(true)
    mockReconnect.mockReturnValue({ ok: true, message: 'Activated Reconnect' })
  })
  afterEach(() => vi.useRealTimers())

  it('healthy pipe (409): no-op, does NOT drive recovery', async () => {
    mockConflict.mockResolvedValue({ conflicted: true, status: 409 })
    const p = recoverOrchestratorPipeOnce(NOW)
    await vi.runAllTimersAsync()
    const r = await p
    expect(r.verdict).toBe('healthy')
    expect(r.recovered).toBe(false)
    expect(mockReconnect).not.toHaveBeenCalled()
  })

  it('confirmed-absent child drives recovery EVEN under a 409 (#95 ordering, via the boot path)', async () => {
    mockPresence.mockReturnValue(false)                         // orchestrator child gone
    mockConflict.mockResolvedValue({ conflicted: true, status: 409 }) // a same-token coordinator holds the slot
    const p = recoverOrchestratorPipeOnce(NOW)
    await vi.runAllTimersAsync()
    const r = await p
    expect(r.verdict).toBe('dead')                              // present===false outranks the 409
    expect(mockReconnect).toHaveBeenCalledTimes(1)
    expect(r.recovered).toBe(true)
  })

  it('slot-free 200 with no token-holder: dead -> drives recovery', async () => {
    mockPresence.mockReturnValue(true)
    mockConflict.mockResolvedValue({ conflicted: false, status: 200 })
    const p = recoverOrchestratorPipeOnce(NOW)
    await vi.runAllTimersAsync()
    const r = await p
    expect(r.verdict).toBe('dead')
    expect(mockReconnect).toHaveBeenCalledTimes(1)
  })

  it('dead pipe but the wedge-safe gate aborted the drive: recovered=false, but it DID attempt', async () => {
    mockPresence.mockReturnValue(false)
    mockConflict.mockResolvedValue({ conflicted: false, status: 0 })
    mockReconnect.mockReturnValue({ ok: false, message: 'Pane not idle (busy/unknown) -- aborted /mcp drive to avoid wedge' })
    const p = recoverOrchestratorPipeOnce(NOW)
    await vi.runAllTimersAsync()
    const r = await p
    expect(r.verdict).toBe('dead')
    expect(mockReconnect).toHaveBeenCalledTimes(1)
    expect(r.recovered).toBe(false)
  })

  it('inconclusive probe (network error, child present): no recovery', async () => {
    mockPresence.mockReturnValue(true)
    mockConflict.mockResolvedValue({ conflicted: false, status: 0 })
    const p = recoverOrchestratorPipeOnce(NOW)
    await vi.runAllTimersAsync()
    const r = await p
    expect(r.verdict).toBe('inconclusive')
    expect(mockReconnect).not.toHaveBeenCalled()
  })
})
