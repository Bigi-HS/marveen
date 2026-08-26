/**
 * Dedicated tests for POST /api/todos dedup logic (OPS-093, b5a2e109).
 * Uses a distinct temp DB path to avoid conflict with todos-route.test.ts.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import { initDatabase } from '../db.js'
import { tryHandleTodos } from '../web/routes/todos.js'

const TEST_DB = '/tmp/test-todo-dedup.db'

async function call(method: string, fullPath: string, body?: unknown) {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any
  const captured: { status: number; body: any } = { status: 0, body: undefined }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as any
  await tryHandleTodos({ req, res, method, path: url.pathname, url } as any)
  return captured
}

describe('POST /api/todos dedup (OPS-093, b5a2e109)', () => {
  beforeEach(() => { rmSync(TEST_DB, { force: true }); initDatabase(TEST_DB) })
  afterAll(() => rmSync(TEST_DB, { force: true }))

  it('second POST with same title returns existing id + dedup=true (no new row)', async () => {
    const first = await call('POST', '/api/todos', { owner: 'claudia', title: 'Standup meeting', kind: 'task' })
    expect(first.status).toBe(200)
    expect(first.body.dedup).toBeUndefined()

    const second = await call('POST', '/api/todos', { owner: 'claudia', title: 'Standup meeting', kind: 'task' })
    expect(second.status).toBe(200)
    expect(second.body.ok).toBe(true)
    expect(second.body.id).toBe(first.body.id)
    expect(second.body.dedup).toBe(true)

    // Verify only one row was created
    const list = await call('GET', '/api/todos?owner=claudia')
    const allItems = [
      ...list.body.claudia.today,
      ...list.body.claudia.carried,
    ]
    expect(allItems.filter((t: any) => t.title === 'Standup meeting')).toHaveLength(1)
  })

  it('title comparison is case-insensitive and strips surrounding whitespace', async () => {
    const first = await call('POST', '/api/todos', { owner: 'claudia', title: '  Buy milk  ', kind: 'task' })
    const second = await call('POST', '/api/todos', { owner: 'claudia', title: 'buy MILK', kind: 'task' })
    expect(second.body.dedup).toBe(true)
    expect(second.body.id).toBe(first.body.id)
  })

  it('different owner does NOT dedup (cross-owner isolation)', async () => {
    const claudia = await call('POST', '/api/todos', { owner: 'claudia', title: 'shared title', kind: 'task' })
    const hibiki  = await call('POST', '/api/todos', { owner: 'hibiki',  title: 'shared title', kind: 'task' })
    expect(hibiki.body.dedup).toBeUndefined()
    expect(hibiki.body.id).not.toBe(claudia.body.id)
  })

  it('distinct title always creates a new item (no false dedup)', async () => {
    await call('POST', '/api/todos', { owner: 'claudia', title: 'Task A', kind: 'task' })
    const second = await call('POST', '/api/todos', { owner: 'claudia', title: 'Task B', kind: 'task' })
    expect(second.body.dedup).toBeUndefined()
    expect(second.body.ok).toBe(true)
  })
})
