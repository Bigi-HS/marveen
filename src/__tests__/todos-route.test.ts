import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import {
  initDatabase, getDb, nowEpochS, dayBucket,
  createTodoItem, getTodoItem,
} from '../db.js'
import { buildOwnerView, tryHandleTodos } from '../web/routes/todos.js'
import type { TodoItem } from '../db.js'

const TEST_DB = '/tmp/test-todos-route.db'

function setCreatedAt(id: string, epoch: number): void {
  getDb().prepare('UPDATE todo_items SET created_at = ? WHERE id = ?').run(epoch, id)
}

// Minimal RouteContext driver: a Readable req carrying an optional JSON body and
// a res capturing status + body.
async function call(method: string, fullPath: string, body?: unknown) {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any
  const captured: { status: number; body: any } = { status: 0, body: undefined }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as any
  const handled = await tryHandleTodos({ req, res, method, path: url.pathname, url } as any)
  return { handled, ...captured }
}

describe('buildOwnerView (pure section split)', () => {
  it('routes items into today / carried / folyamatban / doneToday and counts cap', () => {
    const nowBucket = 1_000_000
    const mk = (over: Partial<TodoItem>): TodoItem => ({
      id: 'x', owner: 'claudia', section: null, kind: 'task', title: 't', detail: null,
      done: 0, status: null, target_val: null, actual_val: null, sort_order: null,
      last_progress_at: null, progress_note: null,
      created_at: nowBucket + 10, updated_at: nowBucket + 10, done_at: null, ...over,
    })
    const rows: TodoItem[] = [
      mk({ id: 'today-task', kind: 'task', created_at: nowBucket + 100 }),
      mk({ id: 'carried-task', kind: 'task', created_at: nowBucket - 100 }),
      mk({ id: 'progress', kind: 'progress', created_at: nowBucket - 5000 }),
      mk({ id: 'done-today', kind: 'task', done: 1, done_at: nowBucket + 50 }),
      mk({ id: 'done-old', kind: 'task', done: 1, done_at: nowBucket - 50 }),
      mk({ id: 'stale-habit', kind: 'habit', section: 'fitness', created_at: nowBucket - 100 }),
      mk({ id: 'today-habit', kind: 'habit', section: 'fitness', created_at: nowBucket + 20, status: 'done' }),
    ]
    const v = buildOwnerView(rows, nowBucket)
    expect(v.today.map(r => r.id).sort()).toEqual(['today-habit', 'today-task'])
    expect(v.carried.map(r => r.id)).toEqual(['carried-task'])
    expect(v.folyamatban.map(r => r.id)).toEqual(['progress'])
    expect(v.doneToday.map(r => r.id)).toEqual(['done-today'])
    // stale-habit (prev bucket) is dropped; done-old is not in the active set anyway.
    // capCount = open items created this bucket: today-task + today-habit = 2.
    expect(v.capCount).toBe(2)
  })
})

describe('todos route — CRUD + envelope', () => {
  beforeEach(() => { rmSync(TEST_DB, { force: true }); initDatabase(TEST_DB) })
  afterAll(() => rmSync(TEST_DB, { force: true }))

  it('POST creates an item with server-stamped time, ignoring body created_at (DM-AC2)', async () => {
    const r = await call('POST', '/api/todos', { owner: 'claudia', title: 'buy milk', created_at: 0 })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    const row = getTodoItem(r.body.id)!
    expect(row.title).toBe('buy milk')
    expect(row.created_at).toBeGreaterThan(0)
  })

  it('POST rejects a missing owner and a missing title with 400', async () => {
    expect((await call('POST', '/api/todos', { title: 'x' })).status).toBe(400)
    expect((await call('POST', '/api/todos', { owner: 'claudia' })).status).toBe(400)
  })

  it('POST rejects an invalid kind with 400 (CHECK -> caught)', async () => {
    const r = await call('POST', '/api/todos', { owner: 'claudia', title: 't', kind: 'bogus' })
    expect(r.status).toBe(400)
  })

  it('POST accepts a title with single quotes (WR-AC1)', async () => {
    const r = await call('POST', '/api/todos', { owner: 'hibiki', section: 'fitness', kind: 'habit', title: "it's done", status: 'done' })
    expect(r.status).toBe(200)
    expect(getTodoItem(r.body.id)!.title).toBe("it's done")
  })

  it('GET returns both owners + freshness envelope', async () => {
    await call('POST', '/api/todos', { owner: 'claudia', title: 'task' })
    const r = await call('GET', '/api/todos')
    expect(r.status).toBe(200)
    expect(r.body.claudia).toBeDefined()
    expect(r.body.hibiki).toBeDefined()
    expect(r.body.freshness.claudia.last_write_ago_seconds).toBeGreaterThanOrEqual(0)
    expect(r.body.freshness.hibiki.last_write_ago_seconds).toBeNull()
    // hibiki carries the derived adherence badge
    expect(r.body.hibiki.adherence.total).toBe(7)
  })

  it('GET ?owner=claudia returns only that owner', async () => {
    const r = await call('GET', '/api/todos?owner=claudia')
    expect(r.body.claudia).toBeDefined()
    expect(r.body.hibiki).toBeUndefined()
  })

  it('GET ?owner=bogus -> 400', async () => {
    expect((await call('GET', '/api/todos?owner=bogus')).status).toBe(400)
  })

  it('POST /:id/done marks done; the item moves to doneToday', async () => {
    const c = await call('POST', '/api/todos', { owner: 'claudia', title: 'finish me' })
    const d = await call('POST', `/api/todos/${c.body.id}/done`)
    expect(d.status).toBe(200)
    const view = (await call('GET', '/api/todos?owner=claudia')).body.claudia
    expect(view.doneToday.map((r: any) => r.id)).toContain(c.body.id)
    expect(view.today.map((r: any) => r.id)).not.toContain(c.body.id)
  })

  it('POST /:id/progress ticks last_progress_at + note', async () => {
    const c = await call('POST', '/api/todos', { owner: 'claudia', section: 'learning', kind: 'progress', title: 'ISTQB' })
    const p = await call('POST', `/api/todos/${c.body.id}/progress`, { progress_note: 'ch 4' })
    expect(p.status).toBe(200)
    const row = getTodoItem(c.body.id)!
    expect(row.progress_note).toBe('ch 4')
    expect(row.last_progress_at).not.toBeNull()
  })

  it('PUT edits writable fields, 404 on unknown id', async () => {
    const c = await call('POST', '/api/todos', { owner: 'claudia', title: 'old' })
    expect((await call('PUT', `/api/todos/${c.body.id}`, { title: 'new' })).status).toBe(200)
    expect(getTodoItem(c.body.id)!.title).toBe('new')
    expect((await call('PUT', '/api/todos/nope', { title: 'x' })).status).toBe(404)
  })

  it('DELETE hard-deletes; 404 on unknown id (CAR-AC4)', async () => {
    const c = await call('POST', '/api/todos', { owner: 'claudia', title: 'dismiss' })
    expect((await call('DELETE', `/api/todos/${c.body.id}`)).status).toBe(200)
    expect(getTodoItem(c.body.id)).toBeUndefined()
    expect((await call('DELETE', '/api/todos/nope')).status).toBe(404)
  })

  it('carried-over surfaces a task created before today\'s bucket', async () => {
    const c = await call('POST', '/api/todos', { owner: 'claudia', title: 'from yesterday' })
    setCreatedAt(c.body.id, dayBucket(nowEpochS()) - 100) // just before today's 03:00
    const view = (await call('GET', '/api/todos?owner=claudia')).body.claudia
    expect(view.carried.map((r: any) => r.id)).toContain(c.body.id)
    expect(view.today.map((r: any) => r.id)).not.toContain(c.body.id)
  })
})
