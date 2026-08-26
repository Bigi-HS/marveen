/**
 * Per-owner freshness threshold tests (OPS-139, b7ae67ee).
 * Separate DB path to avoid cross-worktree SQLite conflict.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import { initDatabase } from '../db.js'
import { tryHandleTodos } from '../web/routes/todos.js'

const TEST_DB = '/tmp/test-todo-freshness-threshold.db'

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

describe('Freshness per-owner thresholds (OPS-139, b7ae67ee)', () => {
  beforeEach(() => { rmSync(TEST_DB, { force: true }); initDatabase(TEST_DB) })
  afterAll(() => rmSync(TEST_DB, { force: true }))

  it('freshness response includes threshold_seconds and stale flag per owner', async () => {
    await call('POST', '/api/todos', { owner: 'claudia', title: 'task' })
    const r = await call('GET', '/api/todos')
    const f = r.body.freshness

    // claudia: no time threshold (task state changes, not periodic)
    expect(f.claudia.threshold_seconds).toBeNull()
    expect(f.claudia.stale).toBe(false)

    // hibiki: threshold = 8h (fitness widget ~7h cadence)
    expect(f.hibiki.threshold_seconds).toBe(28800)

    // bond: no time threshold (SRS logging, irregular cadence)
    expect(f.bond.threshold_seconds).toBeNull()
    expect(f.bond.stale).toBe(false)
  })

  it('hibiki is NOT stale when last_write_ago_seconds is null (no writes yet)', async () => {
    const r = await call('GET', '/api/todos?owner=hibiki')
    expect(r.body.freshness.hibiki.last_write_ago_seconds).toBeNull()
    // null ago + threshold -> stale = false (cannot determine staleness without data)
    expect(r.body.freshness.hibiki.stale).toBe(false)
  })

  it('claudia is never stale regardless of write age (no threshold)', async () => {
    await call('POST', '/api/todos', { owner: 'claudia', title: 'old task' })
    const r = await call('GET', '/api/todos?owner=claudia')
    // claudia has a threshold_seconds of null -> stale is always false
    expect(r.body.freshness.claudia.threshold_seconds).toBeNull()
    expect(r.body.freshness.claudia.stale).toBe(false)
  })
})
