import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync, writeFileSync, unlinkSync, utimesSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { decideAction, pruneStamps, supervisorRunning, isPlannedRestartWindow, PLANNED_RESTART_MARKER } from '../web/supervisor-sentinel.js'

// The sentinel's behaviour lives in a pure decision (decideAction) so the
// crash-loop / backoff / escalate logic is testable without spawning processes.
// These tests pin that logic plus the safety contract (setsid-detach, the
// loud-vs-quiet alert split) via source assertions.
const SRC = readFileSync(join(__dirname, '../web/supervisor-sentinel.ts'), 'utf-8')

const OPTS = { minIntervalMs: 120_000, windowMs: 3_600_000, maxPerWindow: 5 }
const T0 = 1_000_000_000_000

describe('decideAction', () => {
  it('does nothing while the supervisor is running', () => {
    expect(decideAction(true, [], T0, OPTS)).toBe('noop')
    // running wins even if the recent history looks like a crash-loop
    const loop = [0, 1, 2, 3, 4].map((i) => T0 - i * 1000)
    expect(decideAction(true, loop, T0, OPTS)).toBe('noop')
  })

  it('relaunches on the first observed death (no prior attempts)', () => {
    expect(decideAction(false, [], T0, OPTS)).toBe('relaunch')
  })

  it('backs off between attempts (no hammering within the min interval)', () => {
    const stamps = [T0 - 30_000] // 30s ago, < 120s floor
    expect(decideAction(false, stamps, T0, OPTS)).toBe('noop')
  })

  it('relaunches again once the min interval has elapsed (still under the cap)', () => {
    const stamps = [T0 - 130_000] // 130s ago, > 120s floor, only 1 in window
    expect(decideAction(false, stamps, T0, OPTS)).toBe('relaunch')
  })

  it('escalates once the per-window cap is reached (crash-loop -> stop relaunching)', () => {
    const stamps = [600_000, 480_000, 360_000, 240_000, 120_000].map((d) => T0 - d) // 5 in the last hour
    expect(decideAction(false, stamps, T0, OPTS)).toBe('escalate')
  })

  it('does not count attempts older than the window toward the cap', () => {
    // 5 attempts but all > 1h ago -> window empty -> a fresh death relaunches.
    const stale = [0, 1, 2, 3, 4].map((i) => T0 - (3_700_000 + i * 1000))
    expect(decideAction(false, stale, T0, OPTS)).toBe('relaunch')
  })
})

describe('pruneStamps', () => {
  it('keeps only stamps within the window', () => {
    const stamps = [T0 - 100, T0 - 3_500_000, T0 - 4_000_000]
    expect(pruneStamps(stamps, T0, 3_600_000)).toEqual([T0 - 100, T0 - 3_500_000])
  })
  it('returns empty when all stamps are stale', () => {
    expect(pruneStamps([T0 - 10_000_000], T0, 3_600_000)).toEqual([])
  })
})

describe('supervisorRunning (live, value-free)', () => {
  it('returns a boolean without throwing', () => {
    expect(typeof supervisorRunning()).toBe('boolean')
  })
})

describe('isPlannedRestartWindow', () => {
  afterEach(() => {
    if (existsSync(PLANNED_RESTART_MARKER)) unlinkSync(PLANNED_RESTART_MARKER)
  })

  it('returns false when the marker file is absent', () => {
    if (existsSync(PLANNED_RESTART_MARKER)) unlinkSync(PLANNED_RESTART_MARKER)
    expect(isPlannedRestartWindow()).toBe(false)
  })

  // Ensure store/ exists in the worktree before writing the marker.
  function ensureMarker(content: string): void {
    const dir = PLANNED_RESTART_MARKER.replace(/\/[^/]+$/, '')
    mkdirSync(dir, { recursive: true })
    writeFileSync(PLANNED_RESTART_MARKER, content)
  }

  it('returns true when the marker file is fresh', () => {
    ensureMarker('planned')
    expect(isPlannedRestartWindow()).toBe(true)
  })

  it('returns false when the marker file is older than 30 minutes (TTL expired)', () => {
    ensureMarker('planned')
    const stale = new Date(Date.now() - 31 * 60 * 1_000)
    utimesSync(PLANNED_RESTART_MARKER, stale, stale)
    expect(isPlannedRestartWindow()).toBe(false)
  })
})

describe('safety contract', () => {
  it('relaunches setsid-detached (detached:true) so a dashboard restart cannot orphan it', () => {
    expect(SRC).toMatch(/detached:\s*true/)
    expect(SRC).toMatch(/\.unref\(\)/)
  })

  it('closes the inherited log fd (no fd leak into the dashboard)', () => {
    expect(SRC).toMatch(/closeSync\(fd\)/)
  })

  it('quiet single-relaunch goes inter-agent to marveen; crash-loop escalates to the operator channel', () => {
    expect(SRC).toMatch(/createAgentMessage\('supervisor-sentinel', MAIN_AGENT_ID/)
    expect(SRC).toMatch(/notifyChannel\(/)
    // the escalate branch is the one that calls notifyChannel
    expect(SRC).toMatch(/function escalateToDominik/)
  })

  it('planned restart window suppresses alertMarveen but still relaunches', () => {
    // The planned path logs quietly (info) and skips alertMarveen; the
    // relaunchSupervisor() call is not conditional on planned.
    expect(SRC).toMatch(/isPlannedRestartWindow\(\)/)
    expect(SRC).toMatch(/planned restart window, relaunched silently/)
    // Failed relaunch always escalates regardless of planned window
    expect(SRC).toMatch(/SULYOS:.*relaunch-a HIBAZOTT/)
  })

  it('detects the supervisor via a cmdline that the node dashboard cannot self-match', () => {
    expect(SRC).toMatch(/pgrep/)
    expect(SRC).toMatch(/fleet-supervisor/)
  })
})
