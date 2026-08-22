// Card 4e5e529a (E2), slice 3: pipeline scheduling. The phantom runner is a
// PIPELINE, not a barrier -- a task launches the moment its depends_on are all
// done and it conflicts with nothing currently running, without waiting for
// sibling tasks in the same wave to finish. These pure functions encode that
// decision so the orchestration layer just calls pickRunnable after every task
// completion (and once at startup).

import type { ParsedTask } from './manifest-parse.js'
import { globsIntersect } from './manifest-guard.js'

// Two tasks cannot run concurrently if either declares the other in
// conflicts_with, or their files_touched globs intersect (would race the same
// file). Mirrors the PRE-validation predicate, applied here at runtime against
// the currently-running set.
export function tasksConflict(a: ParsedTask, b: ParsedTask): boolean {
  if (a.conflicts_with.includes(b.id) || b.conflicts_with.includes(a.id)) return true
  for (const ga of a.files_touched) {
    for (const gb of b.files_touched) {
      if (globsIntersect(ga, gb)) return true
    }
  }
  return false
}

export interface ScheduleState {
  done: Set<string>
  running: Set<string>
}

// Given what is done and currently running, return the ids that may be launched
// NOW: deps satisfied, not already done/running, not conflicting with any running
// task, and the newly-picked set kept internally non-conflicting. A parallel:false
// task runs in isolation -- it starts only when nothing is running and nothing
// else has been picked this tick, and blocks all launches while it runs.
export function pickRunnable(tasks: ParsedTask[], state: ScheduleState): string[] {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const runningTasks = [...state.running].map(id => byId.get(id)).filter((t): t is ParsedTask => !!t)

  // A running sequential (parallel:false) task holds the pipeline exclusively.
  if (runningTasks.some(t => t.parallel === false)) return []

  const picked: ParsedTask[] = []
  for (const task of tasks) {
    if (state.done.has(task.id) || state.running.has(task.id)) continue
    if (!task.depends_on.every(d => state.done.has(d))) continue
    if (runningTasks.some(r => tasksConflict(task, r))) continue
    if (picked.some(p => tasksConflict(task, p))) continue

    if (task.parallel === false) {
      // Sequential task: only when the pipeline is otherwise empty this tick.
      if (runningTasks.length > 0 || picked.length > 0) continue
      picked.push(task)
      break // runs alone -- pick nothing else this tick
    }
    picked.push(task)
  }
  return picked.map(t => t.id)
}

export interface SimStep {
  completed: string | null
  launched: string[]
}

// Deterministic dry-run of the pipeline. Launches the initial runnable set, then
// completes running tasks one at a time in launch (FIFO) order, calling
// pickRunnable after each completion. Models the no-barrier property: a task
// appears the step its dependency completes, not after a whole wave. Useful for
// tests and a manifest dry-run.
export function simulateSchedule(tasks: ParsedTask[]): SimStep[] {
  const done = new Set<string>()
  const running = new Set<string>()
  const fifo: string[] = []
  const steps: SimStep[] = []

  const launch = (completed: string | null): void => {
    const ids = pickRunnable(tasks, { done, running })
    for (const id of ids) {
      running.add(id)
      fifo.push(id)
    }
    steps.push({ completed, launched: ids })
  }

  launch(null)
  while (fifo.length > 0) {
    const finishing = fifo.shift() as string
    running.delete(finishing)
    done.add(finishing)
    launch(finishing)
  }
  return steps
}
