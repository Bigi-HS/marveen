import { describe, it, expect } from 'vitest'
import {
  tasksConflict,
  pickRunnable,
  simulateSchedule,
} from '../phantom/manifest-schedule.js'
import type { ParsedTask } from '../phantom/manifest-parse.js'

// Card 4e5e529a (E2), slice 3: pipeline scheduling. The runner is a PIPELINE, not
// a barrier -- a task launches the moment its deps are done and it conflicts with
// nothing currently running, without waiting for sibling tasks to finish. These
// pure functions encode that decision; the orchestration layer just calls
// pickRunnable after every completion.

const t = (
  id: string,
  files: string[],
  extra: Partial<ParsedTask> = {},
): ParsedTask => ({
  id, card: 'c0ffee00', title: id, body: 'b',
  files_touched: files, depends_on: [], conflicts_with: [], parallel: true,
  ...extra,
})

describe('tasksConflict', () => {
  it('is true on file-overlap', () => {
    expect(tasksConflict(t('a', ['src/db.ts']), t('b', ['src/db.ts']))).toBe(true)
  })
  it('is true on a declared conflicts_with (either direction)', () => {
    expect(tasksConflict(t('a', ['x.ts'], { conflicts_with: ['b'] }), t('b', ['y.ts']))).toBe(true)
    expect(tasksConflict(t('a', ['x.ts']), t('b', ['y.ts'], { conflicts_with: ['a'] }))).toBe(true)
  })
  it('is false for disjoint, non-declared tasks', () => {
    expect(tasksConflict(t('a', ['x.ts']), t('b', ['y.ts']))).toBe(false)
  })
})

describe('pickRunnable', () => {
  it('launches all independent non-conflicting tasks at once', () => {
    const tasks = [t('a', ['a.ts']), t('b', ['b.ts']), t('c', ['c.ts'])]
    expect(pickRunnable(tasks, { done: new Set(), running: new Set() }).sort())
      .toEqual(['a', 'b', 'c'])
  })

  it('withholds a task whose dependency is not yet done', () => {
    const tasks = [t('a', ['a.ts']), t('b', ['b.ts'], { depends_on: ['a'] })]
    expect(pickRunnable(tasks, { done: new Set(), running: new Set() })).toEqual(['a'])
    expect(pickRunnable(tasks, { done: new Set(['a']), running: new Set() })).toEqual(['b'])
  })

  it('does not relaunch done or running tasks', () => {
    const tasks = [t('a', ['a.ts']), t('b', ['b.ts'])]
    expect(pickRunnable(tasks, { done: new Set(['a']), running: new Set(['b']) })).toEqual([])
  })

  it('withholds a task conflicting with a running task', () => {
    const tasks = [t('a', ['src/db.ts']), t('b', ['src/db.ts'])]
    expect(pickRunnable(tasks, { done: new Set(), running: new Set(['a']) })).toEqual([])
  })

  it('picks only one of two mutually-conflicting runnable tasks per tick', () => {
    const tasks = [t('a', ['src/db.ts']), t('b', ['src/db.ts'])]
    const picked = pickRunnable(tasks, { done: new Set(), running: new Set() })
    expect(picked).toHaveLength(1)
  })

  it('runs a parallel:false task alone (nothing else picked that tick)', () => {
    const tasks = [t('s', ['s.ts'], { parallel: false }), t('a', ['a.ts']), t('b', ['b.ts'])]
    expect(pickRunnable(tasks, { done: new Set(), running: new Set() })).toEqual(['s'])
  })

  it('does not start anything while a parallel:false task is running', () => {
    const tasks = [t('s', ['s.ts'], { parallel: false }), t('a', ['a.ts'])]
    expect(pickRunnable(tasks, { done: new Set(), running: new Set(['s']) })).toEqual([])
  })

  it('defers a parallel:false task while parallel tasks are still running', () => {
    const tasks = [t('a', ['a.ts']), t('s', ['s.ts'], { parallel: false })]
    expect(pickRunnable(tasks, { done: new Set(), running: new Set(['a']) })).toEqual([])
  })
})

describe('simulateSchedule (pipeline, not barrier)', () => {
  it('launches a dependent immediately when its single dep completes', () => {
    const steps = simulateSchedule([t('a', ['a.ts']), t('b', ['b.ts'], { depends_on: ['a'] })])
    expect(steps[0]).toEqual({ completed: null, launched: ['a'] })
    expect(steps[1]).toEqual({ completed: 'a', launched: ['b'] })
  })

  it('does not barrier: a fast branch unblocks its dependent without waiting on a slow sibling', () => {
    // a, b independent and launched together; c depends only on a. When a finishes,
    // c starts immediately even though b is still running (no batch barrier).
    const steps = simulateSchedule([
      t('a', ['a.ts']),
      t('b', ['b.ts']),
      t('c', ['c.ts'], { depends_on: ['a'] }),
    ])
    expect(steps[0].launched.sort()).toEqual(['a', 'b'])
    const afterA = steps.find(s => s.completed === 'a')
    expect(afterA?.launched).toEqual(['c'])
  })

  it('serialises two conflicting tasks across completions', () => {
    const steps = simulateSchedule([t('a', ['src/db.ts']), t('b', ['src/db.ts'])])
    expect(steps[0].launched).toHaveLength(1)
    const first = steps[0].launched[0]
    const other = first === 'a' ? 'b' : 'a'
    const afterFirst = steps.find(s => s.completed === first)
    expect(afterFirst?.launched).toEqual([other])
  })

  it('eventually launches every task exactly once', () => {
    const steps = simulateSchedule([
      t('a', ['a.ts']),
      t('b', ['b.ts'], { depends_on: ['a'] }),
      t('c', ['c.ts'], { depends_on: ['a'] }),
      t('d', ['d.ts'], { depends_on: ['b', 'c'] }),
    ])
    const launched = steps.flatMap(s => s.launched).sort()
    expect(launched).toEqual(['a', 'b', 'c', 'd'])
  })
})
