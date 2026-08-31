import { describe, it, expect, vi } from 'vitest'
import {
  runSurvivalCycle,
  hasNewIssues,
  healthAlertBackoffMs,
  type SurvivalDeps,
  type SurvivalState,
  type OverdueTask,
} from '../web/token-outage-survival.js'

const NOW = 1_700_000_000_000

function makeTask(id: string, name = `task-${id}`): OverdueTask {
  return { id, name, description: `desc-${id}`, agent: 'forge' }
}

function makeDeps(
  over: Partial<SurvivalDeps> & { limited?: boolean; issues?: string[]; tasks?: OverdueTask[] } = {},
): SurvivalDeps & { _state: () => SurvivalState } {
  let store: SurvivalState = { notifiedTaskIds: [], lastHealthIssues: [], lastHealthAlertTs: 0 }
  const { limited = false, issues = [], tasks = [], ...rest } = over
  const deps: SurvivalDeps = {
    isLimited: () => limited,
    checkHealth: vi.fn(() => Promise.resolve(issues)),
    getOverdueTasks: vi.fn(() => tasks),
    sendAlert: vi.fn(async () => true),
    readState: () => ({ ...store }),
    writeState: (s) => { store = { ...s } },
    nowMs: () => NOW,
    ...rest,
  }
  return Object.assign(deps, { _state: () => ({ ...store }) })
}

// ---- hasNewIssues ----

describe('hasNewIssues', () => {
  it('returns true when a new issue appears', () => {
    expect(hasNewIssues(['dashboard:down', 'session:dave:down'], ['dashboard:down'])).toBe(true)
  })

  it('returns false when all issues were already known', () => {
    expect(hasNewIssues(['dashboard:down'], ['dashboard:down', 'session:dave:down'])).toBe(false)
  })

  it('returns true when issue list goes from empty to non-empty', () => {
    expect(hasNewIssues(['dashboard:down'], [])).toBe(true)
  })

  it('returns false for empty issues regardless of lastKnown', () => {
    expect(hasNewIssues([], ['dashboard:down'])).toBe(false)
  })
})

// ---- runSurvivalCycle ----

describe('runSurvivalCycle -- not in outage', () => {
  it('returns skipped=true and does not call health or tasks', async () => {
    const deps = makeDeps({ limited: false })
    const r = await runSurvivalCycle(deps)
    expect(r.skipped).toBe(true)
    expect(deps.checkHealth).not.toHaveBeenCalled()
    expect(deps.getOverdueTasks).not.toHaveBeenCalled()
    expect(deps.sendAlert).not.toHaveBeenCalled()
  })

  it('clears notifiedTaskIds when exiting outage', async () => {
    const deps = makeDeps({ limited: false })
    deps.writeState({ notifiedTaskIds: ['t1', 't2'], lastHealthIssues: [], lastHealthAlertTs: 0 })
    await runSurvivalCycle(deps)
    expect(deps._state().notifiedTaskIds).toEqual([])
  })
})

describe('runSurvivalCycle -- in outage, no issues, no tasks', () => {
  it('returns skipped=false with zeros', async () => {
    const deps = makeDeps({ limited: true, issues: [], tasks: [] })
    const r = await runSurvivalCycle(deps)
    expect(r.skipped).toBe(false)
    expect(r.healthIssues).toEqual([])
    expect(r.healthAlertSent).toBe(false)
    expect(r.remindersDelivered).toBe(0)
    expect(deps.sendAlert).not.toHaveBeenCalled()
  })
})

describe('runSurvivalCycle -- health issues', () => {
  it('sends health alert on first detection', async () => {
    const deps = makeDeps({ limited: true, issues: ['dashboard:down'] })
    const r = await runSurvivalCycle(deps)
    expect(r.healthIssues).toEqual(['dashboard:down'])
    expect(r.healthAlertSent).toBe(true)
    expect(deps.sendAlert).toHaveBeenCalledOnce()
    const call = (deps.sendAlert as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(call).toContain('dashboard:down')
  })

  it('does NOT re-alert for the same issues within throttle window', async () => {
    const recentAlert = NOW - 60_000 // 1 min ago, within 5 min throttle
    const deps = makeDeps({ limited: true, issues: ['dashboard:down'] })
    deps.writeState({ notifiedTaskIds: [], lastHealthIssues: ['dashboard:down'], lastHealthAlertTs: recentAlert })
    const r = await runSurvivalCycle(deps)
    expect(r.healthAlertSent).toBe(false)
    expect(deps.sendAlert).not.toHaveBeenCalled()
  })

  it('re-alerts when a NEW issue appears even within throttle window', async () => {
    const recentAlert = NOW - 60_000
    const deps = makeDeps({ limited: true, issues: ['dashboard:down', 'session:dave:down'] })
    deps.writeState({ notifiedTaskIds: [], lastHealthIssues: ['dashboard:down'], lastHealthAlertTs: recentAlert })
    const r = await runSurvivalCycle(deps)
    expect(r.healthAlertSent).toBe(true)
  })

  it('re-alerts for the same issues after throttle window expires', async () => {
    const oldAlert = NOW - 10 * 60 * 1000 // 10 min ago, past 5 min throttle
    const deps = makeDeps({ limited: true, issues: ['dashboard:down'] })
    deps.writeState({ notifiedTaskIds: [], lastHealthIssues: ['dashboard:down'], lastHealthAlertTs: oldAlert })
    const r = await runSurvivalCycle(deps)
    expect(r.healthAlertSent).toBe(true)
  })

  it('updates state with current issues and timestamp after alert', async () => {
    const deps = makeDeps({ limited: true, issues: ['session:thor:down'] })
    await runSurvivalCycle(deps)
    expect(deps._state().lastHealthIssues).toEqual(['session:thor:down'])
    expect(deps._state().lastHealthAlertTs).toBe(NOW)
  })
})

// ---- healthAlertBackoffMs ----

describe('healthAlertBackoffMs', () => {
  it('returns base (5min) for the first repeat (1 alert sent)', () => {
    expect(healthAlertBackoffMs(1)).toBe(5 * 60 * 1000)
  })

  it('treats 0/undefined-ish counts as the base interval', () => {
    expect(healthAlertBackoffMs(0)).toBe(5 * 60 * 1000)
  })

  it('grows exponentially: 5min -> 15min -> 45min', () => {
    expect(healthAlertBackoffMs(2)).toBe(15 * 60 * 1000)
    expect(healthAlertBackoffMs(3)).toBe(45 * 60 * 1000)
  })

  it('caps at 2h regardless of how many alerts were sent', () => {
    expect(healthAlertBackoffMs(4)).toBe(2 * 60 * 60 * 1000)
    expect(healthAlertBackoffMs(20)).toBe(2 * 60 * 60 * 1000)
  })
})

describe('runSurvivalCycle -- health alert escalate-once-then-backoff', () => {
  it('sets healthAlertCount to 1 on the first alert', async () => {
    const deps = makeDeps({ limited: true, issues: ['dashboard:down'] })
    await runSurvivalCycle(deps)
    expect(deps._state().healthAlertCount).toBe(1)
  })

  it('does NOT re-alert at 10min when 2 alerts already sent (needs 15min)', async () => {
    const deps = makeDeps({ limited: true, issues: ['dashboard:down'] })
    deps.writeState({
      notifiedTaskIds: [], lastHealthIssues: ['dashboard:down'],
      lastHealthAlertTs: NOW - 10 * 60 * 1000, healthAlertCount: 2,
    })
    const r = await runSurvivalCycle(deps)
    expect(r.healthAlertSent).toBe(false)
    expect(deps.sendAlert).not.toHaveBeenCalled()
  })

  it('re-alerts at 20min when 2 alerts already sent (past 15min backoff) and increments count', async () => {
    const deps = makeDeps({ limited: true, issues: ['dashboard:down'] })
    deps.writeState({
      notifiedTaskIds: [], lastHealthIssues: ['dashboard:down'],
      lastHealthAlertTs: NOW - 20 * 60 * 1000, healthAlertCount: 2,
    })
    const r = await runSurvivalCycle(deps)
    expect(r.healthAlertSent).toBe(true)
    expect(deps._state().healthAlertCount).toBe(3)
  })

  it('resets healthAlertCount to 1 when a genuinely new issue appears', async () => {
    const deps = makeDeps({ limited: true, issues: ['dashboard:down', 'session:dave:down'] })
    deps.writeState({
      notifiedTaskIds: [], lastHealthIssues: ['dashboard:down'],
      lastHealthAlertTs: NOW - 60_000, healthAlertCount: 4,
    })
    const r = await runSurvivalCycle(deps)
    expect(r.healthAlertSent).toBe(true)
    expect(deps._state().healthAlertCount).toBe(1)
  })

  it('honours the 2h cap: re-alerts only after 2h once backoff is saturated', async () => {
    const deps = makeDeps({ limited: true, issues: ['dashboard:down'] })
    deps.writeState({
      notifiedTaskIds: [], lastHealthIssues: ['dashboard:down'],
      lastHealthAlertTs: NOW - 119 * 60 * 1000, healthAlertCount: 8,
    })
    const r = await runSurvivalCycle(deps)
    expect(r.healthAlertSent).toBe(false)
  })

  it('resets healthAlertCount to 0 when issues clear', async () => {
    const deps = makeDeps({ limited: true, issues: [] })
    deps.writeState({
      notifiedTaskIds: [], lastHealthIssues: ['dashboard:down'],
      lastHealthAlertTs: NOW - 60_000, healthAlertCount: 3,
    })
    await runSurvivalCycle(deps)
    expect(deps._state().healthAlertCount).toBe(0)
  })
})

describe('runSurvivalCycle -- reminder fire', () => {
  it('sends alert for each overdue task', async () => {
    const tasks = [makeTask('t1'), makeTask('t2')]
    const deps = makeDeps({ limited: true, issues: [], tasks })
    const r = await runSurvivalCycle(deps)
    expect(r.remindersDelivered).toBe(2)
    expect(deps.sendAlert).toHaveBeenCalledTimes(2)
    const calls = (deps.sendAlert as ReturnType<typeof vi.fn>).mock.calls as [string][]
    expect(calls[0][0]).toContain('task-t1')
    expect(calls[1][0]).toContain('task-t2')
  })

  it('does NOT re-send a task already in notifiedTaskIds', async () => {
    const tasks = [makeTask('t1'), makeTask('t2')]
    const deps = makeDeps({ limited: true, issues: [], tasks })
    deps.writeState({ notifiedTaskIds: ['t1'], lastHealthIssues: [], lastHealthAlertTs: 0 })
    const r = await runSurvivalCycle(deps)
    expect(r.remindersDelivered).toBe(1)
    const call = (deps.sendAlert as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(call).toContain('task-t2')
  })

  it('accumulates notifiedTaskIds across tasks', async () => {
    const tasks = [makeTask('t1'), makeTask('t2')]
    const deps = makeDeps({ limited: true, issues: [], tasks })
    await runSurvivalCycle(deps)
    expect(deps._state().notifiedTaskIds.sort()).toEqual(['t1', 't2'])
  })

  it('does not add task to state when sendAlert returns false', async () => {
    const tasks = [makeTask('t1')]
    const deps = makeDeps({ limited: true, issues: [], tasks, sendAlert: vi.fn(async () => false) })
    const r = await runSurvivalCycle(deps)
    expect(r.remindersDelivered).toBe(0)
    expect(deps._state().notifiedTaskIds).toEqual([])
  })

  it('reminder text includes task name and direct-delivery notice', async () => {
    const task: OverdueTask = { id: 'abc', name: 'daily-standup', description: 'Check kanban', agent: 'forge' }
    const deps = makeDeps({ limited: true, issues: [], tasks: [task] })
    await runSurvivalCycle(deps)
    const text = (deps.sendAlert as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(text).toContain('daily-standup')
    expect(text).toContain('Check kanban')
    expect(text).toContain('direct delivery')
  })
})

describe('runSurvivalCycle -- sendAlert failure resilience', () => {
  it('continues to next task if one alert fails', async () => {
    const tasks = [makeTask('t1'), makeTask('t2')]
    let call = 0
    const sendAlert = vi.fn(async () => {
      call++
      return call === 1 ? false : true // first fails, second succeeds
    })
    const deps = makeDeps({ limited: true, issues: [], tasks, sendAlert })
    const r = await runSurvivalCycle(deps)
    expect(r.remindersDelivered).toBe(1)
    expect(deps._state().notifiedTaskIds).toEqual(['t2'])
  })
})
