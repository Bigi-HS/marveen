// Card 4e5e529a (E2), slice 2: parse + validate the phantom-task-manifest schema
// and order tasks by their depends_on DAG. Pure, so the runner rejects a
// malformed or cyclic manifest before launching any phantom. The schema is
// defined in the phantom-task-manifest skill (card 52ec0377 / E1): one JSON task
// per file with id, card, title, body, files_touched (+ optional depends_on,
// conflicts_with, parallel).

import type { ManifestTask } from './manifest-guard.js'

// A task after parsing: required fields validated, optional fields defaulted.
export interface ParsedTask extends ManifestTask {
  card: string
  title: string
  body: string
  depends_on: string[]
  conflicts_with: string[]
  parallel: boolean
}

export type ParseResult =
  | { ok: true; task: ParsedTask }
  | { ok: false; errors: string[] }

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

// Validate one raw JSON value into a ParsedTask, collecting ALL problems (not
// just the first) so a manifest author sees everything wrong in one pass.
export function parseManifestTask(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['task must be a JSON object'] }
  }
  const o = raw as Record<string, unknown>
  const errors: string[] = []

  for (const f of ['id', 'card', 'title', 'body'] as const) {
    if (typeof o[f] !== 'string' || (o[f] as string).length === 0) {
      errors.push(`${f}: required non-empty string`)
    }
  }

  if (!isStringArray(o.files_touched)) {
    errors.push('files_touched: required string[]')
  } else if (o.files_touched.length === 0) {
    errors.push('files_touched: must list at least one path/glob')
  }

  if (o.depends_on !== undefined && !isStringArray(o.depends_on)) {
    errors.push('depends_on: must be string[]')
  }
  if (o.conflicts_with !== undefined && !isStringArray(o.conflicts_with)) {
    errors.push('conflicts_with: must be string[]')
  }
  if (o.parallel !== undefined && typeof o.parallel !== 'boolean') {
    errors.push('parallel: must be a boolean')
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    task: {
      id: o.id as string,
      card: o.card as string,
      title: o.title as string,
      body: o.body as string,
      files_touched: o.files_touched as string[],
      depends_on: (o.depends_on as string[] | undefined) ?? [],
      conflicts_with: (o.conflicts_with as string[] | undefined) ?? [],
      parallel: (o.parallel as boolean | undefined) ?? true,
    },
  }
}

// Cross-task validation over an already-parsed manifest: unique ids, every
// depends_on / conflicts_with reference resolves, and the depends_on graph is
// acyclic. Returns all errors (empty => valid).
export function validateManifest(tasks: ParsedTask[]): { errors: string[] } {
  const errors: string[] = []
  const ids = new Set<string>()
  const seen = new Set<string>()
  for (const task of tasks) {
    if (seen.has(task.id)) errors.push(`duplicate id: ${task.id}`)
    seen.add(task.id)
    ids.add(task.id)
  }

  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) errors.push(`${task.id}.depends_on references unknown id: ${dep}`)
    }
    for (const con of task.conflicts_with) {
      if (!ids.has(con)) errors.push(`${task.id}.conflicts_with references unknown id: ${con}`)
    }
  }

  const order = topoOrder(tasks)
  if (!order.ok) errors.push(`dependency cycle: ${order.cycle.join(' -> ')}`)

  return { errors }
}

export type TopoResult =
  | { ok: true; order: string[] }
  | { ok: false; cycle: string[] }

// Order tasks so every depends_on precedes its dependents (DFS post-order).
// Detects cycles (including self-deps) and returns the offending chain. Edges to
// unknown ids are ignored here -- validateManifest reports those separately.
export function topoOrder(tasks: ParsedTask[]): TopoResult {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  function visit(id: string): string[] | null {
    const st = state.get(id)
    if (st === 'done') return null
    if (st === 'visiting') {
      // Found a back-edge: slice the active stack from the first occurrence.
      const from = stack.indexOf(id)
      return [...stack.slice(from), id]
    }
    state.set(id, 'visiting')
    stack.push(id)
    const task = byId.get(id)
    for (const dep of task?.depends_on ?? []) {
      if (!byId.has(dep)) continue // unknown dep: not our concern here
      const cycle = visit(dep)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(id, 'done')
    order.push(id)
    return null
  }

  for (const task of tasks) {
    const cycle = visit(task.id)
    if (cycle) return { ok: false, cycle }
  }
  return { ok: true, order }
}
