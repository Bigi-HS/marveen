import { randomUUID } from 'node:crypto'
import {
  type TodoItem, type TodoOwner,
  listActiveTodos, createTodoItem, updateTodoItem, markTodoDone,
  tickTodoProgress, deleteTodoItem, getTodoItem,
  todoLastWriteAgoSeconds, trainingAdherence, dayBucket, nowEpochS,
} from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const OWNERS: TodoOwner[] = ['claudia', 'hibiki', 'bond']
function isOwner(v: unknown): v is TodoOwner { return v === 'claudia' || v === 'hibiki' || v === 'bond' }

export interface OwnerView {
  today: TodoItem[]
  carried: TodoItem[]
  folyamatban: TodoItem[]
  doneToday: TodoItem[]
  capCount: number
}

// Partition an owner's active rows into the widget's render sections. Uses a
// single bucket threshold (created_at vs nowBucket) — no per-row dayBucket call,
// since dayBucket(now) is itself a boundary so `created_at >= nowBucket` is
// equivalent to `dayBucket(created_at) >= dayBucket(now)`.
//
// Section rules:
//  - progress items -> "Folyamatban" (persistent; never carried, never red) [LP-AC1]
//  - open items created this bucket -> TODAY (task/habit/metric) [TC-AC1]
//  - open task items from a previous bucket -> CARRIED-OVER [TC-AC2]
//  - open habit/metric from a previous bucket -> dropped (read-only daily history) [FIT-AC4]
//  - done items completed this bucket -> "Kész ma" tail [CO-AC3]
//  - capCount = open items created this bucket, any kind [CAP-AC1]
export function buildOwnerView(rows: TodoItem[], nowBucket: number): OwnerView {
  const today: TodoItem[] = []
  const carried: TodoItem[] = []
  const folyamatban: TodoItem[] = []
  const doneToday: TodoItem[] = []
  let capCount = 0
  for (const r of rows) {
    if (r.done === 1) {
      if (r.done_at != null && r.done_at >= nowBucket) doneToday.push(r)
      continue
    }
    const createdToday = r.created_at >= nowBucket
    if (createdToday) capCount++
    if (r.kind === 'progress') { folyamatban.push(r); continue }
    if (createdToday) today.push(r)
    else if (r.kind === 'task') carried.push(r)
  }
  return { today, carried, folyamatban, doneToday, capCount }
}

interface OwnerEnvelope extends OwnerView { adherence?: { active: number; total: number } }

// Assemble the GET envelope for one owner (+ adherence badge for Hibiki).
function ownerEnvelope(owner: TodoOwner, nowBucket: number): OwnerEnvelope {
  const view = buildOwnerView(listActiveTodos(owner), nowBucket)
  if (owner === 'hibiki') return { ...view, adherence: trainingAdherence('hibiki', 7) }
  return view
}

export function buildTodosResponse(only?: TodoOwner): Record<string, unknown> {
  const nowBucket = dayBucket(nowEpochS())
  const owners = only ? [only] : OWNERS
  const out: Record<string, unknown> = {}
  const freshness: Record<string, { last_write_ago_seconds: number | null }> = {}
  for (const o of owners) {
    out[o] = ownerEnvelope(o, nowBucket)
    freshness[o] = { last_write_ago_seconds: todoLastWriteAgoSeconds(o) }
  }
  out.freshness = freshness
  return out
}

// Agent-writable create fields. Timestamps/done are server-controlled (DM-AC2);
// any created_at/updated_at/done/done_at in the body is silently ignored.
function pickWriteFields(data: Record<string, unknown>) {
  return {
    section: data.section as TodoItem['section'] | undefined,
    kind: data.kind as TodoItem['kind'] | undefined,
    title: typeof data.title === 'string' ? data.title : undefined,
    detail: (data.detail ?? undefined) as string | null | undefined,
    status: (data.status ?? undefined) as string | null | undefined,
    target_val: (data.target_val ?? undefined) as number | null | undefined,
    actual_val: (data.actual_val ?? undefined) as number | null | undefined,
    sort_order: (data.sort_order ?? undefined) as number | null | undefined,
    progress_note: (data.progress_note ?? undefined) as string | null | undefined,
  }
}

function isConstraintError(err: unknown): boolean {
  return err instanceof Error && /constraint/i.test(err.message)
}

export async function tryHandleTodos(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/todos' && method === 'GET') {
    const ownerParam = url.searchParams.get('owner')
    if (ownerParam && !isOwner(ownerParam)) { json(res, { error: 'Ismeretlen owner' }, 400); return true }
    json(res, buildTodosResponse(ownerParam && isOwner(ownerParam) ? ownerParam : undefined))
    return true
  }

  if (path === '/api/todos' && method === 'POST') {
    const data = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    if (!isOwner(data.owner)) { json(res, { error: 'owner kötelező (claudia|hibiki|bond)' }, 400); return true }
    if (typeof data.title !== 'string' || data.title.trim() === '') {
      json(res, { error: 'title kötelező' }, 400); return true
    }
    // Dedup (OPS-093): before inserting, check for a pending task with the same
    // normalized title for this owner. Return the existing item rather than duplicating.
    const normalizedTitle = data.title.trim().toLowerCase()
    const existing = listActiveTodos(data.owner).find(
      (t) => t.done === 0 && t.kind === 'task' && t.title.trim().toLowerCase() === normalizedTitle,
    )
    if (existing) {
      json(res, { ok: true, id: existing.id, dedup: true })
      return true
    }
    const id = randomUUID().slice(0, 8)
    try {
      createTodoItem({ id, owner: data.owner, ...pickWriteFields(data) })
    } catch (err) {
      if (isConstraintError(err)) { json(res, { error: 'Érvénytelen mező (CHECK)' }, 400); return true }
      throw err
    }
    json(res, { ok: true, id })
    return true
  }

  const idMatch = path.match(/^\/api\/todos\/([^/]+)$/)
  if (idMatch && method === 'PUT') {
    const id = decodeURIComponent(idMatch[1])
    const data = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    try {
      if (updateTodoItem(id, pickWriteFields(data))) { json(res, { ok: true }); return true }
    } catch (err) {
      if (isConstraintError(err)) { json(res, { error: 'Érvénytelen mező (CHECK)' }, 400); return true }
      throw err
    }
    json(res, { error: 'Tétel nem található' }, 404)
    return true
  }

  if (idMatch && method === 'DELETE') {
    const id = decodeURIComponent(idMatch[1])
    if (deleteTodoItem(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Tétel nem található' }, 404)
    return true
  }

  const doneMatch = path.match(/^\/api\/todos\/([^/]+)\/done$/)
  if (doneMatch && method === 'POST') {
    const id = decodeURIComponent(doneMatch[1])
    if (markTodoDone(id)) { json(res, { ok: true }); return true }
    json(res, { error: 'Tétel nem található' }, 404)
    return true
  }

  const progressMatch = path.match(/^\/api\/todos\/([^/]+)\/progress$/)
  if (progressMatch && method === 'POST') {
    const id = decodeURIComponent(progressMatch[1])
    if (!getTodoItem(id)) { json(res, { error: 'Tétel nem található' }, 404); return true }
    const data = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    const note = typeof data.progress_note === 'string' ? data.progress_note : null
    tickTodoProgress(id, note)
    json(res, { ok: true })
    return true
  }

  return false
}
