// PUT /api/kanban/:id unknown-field fail-closed (card f87f3448).
//
// Problem: PUT {status:'done', append_description:'...'} -> HTTP 200 {"ok":true}
// but append_description was silently dropped. The caller has no way to know
// half the request was ignored.
//
// Fix: the route rejects requests that contain any key NOT in the KNOWN_PUT_FIELDS
// set, returning 400 {"error":"Unknown fields: ...", "unknown":[...]}.
//
// Two axes:
//   (a) unknown field -> 400 with the field name listed
//   (b) known fields still pass through correctly (regression guard)

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import { createCard, configureKanban, invalidateColumnsCache } from '../noa-kanban.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
  configureKanban({ isRunning: () => false, agentNames: [] })
})

function wipe(): void {
  const db = getNoaDb()
  db.prepare('DELETE FROM kanban_comments').run()
  db.prepare('DELETE FROM kanban_cards').run()
  db.prepare("DELETE FROM board_columns WHERE id NOT IN ('planned','in_progress','waiting','done','icebox')").run()
  invalidateColumnsCache()
}
beforeEach(wipe)
afterEach(wipe)

// ---------------------------------------------------------------------------
// Minimal HTTP mock -- enough for tryHandleKanban
// ---------------------------------------------------------------------------

function makePutCtx(id: string, body: Record<string, unknown>): { ctx: RouteContext; captured: { status: number; body: string } } {
  const bodyStr = JSON.stringify(body)
  const captured = { status: 200, body: '' }

  const req = Object.assign(Readable.from([Buffer.from(bodyStr)]), {
    method: 'PUT',
    headers: { 'content-length': String(Buffer.byteLength(bodyStr)) },
  }) as unknown as IncomingMessage

  const res = {
    writeHead(status: number) { captured.status = status },
    end(data: string) { captured.body = data },
  } as unknown as ServerResponse

  const path = `/api/kanban/${id}`
  const url = new URL(`http://localhost${path}`)
  const ctx: RouteContext = { req, res, path, method: 'PUT', url, identity: null as never }
  return { ctx, captured }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PUT /api/kanban/:id -- unknown field rejection (card f87f3448)', () => {
  it('rejects an entirely unknown field with 400', async () => {
    const card = createCard({ id: 'test01', title: 'T', status: 'planned', priority: 'normal', project: 'ENG' })
    const { ctx, captured } = makePutCtx(card.id, { append_description: 'foo' })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(400)
    const parsed = JSON.parse(captured.body)
    expect(parsed.error).toMatch(/unknown field/i)
    expect(parsed.unknown).toContain('append_description')
  })

  it('rejects a mix of known + unknown fields, lists the unknown ones', async () => {
    const card = createCard({ id: 'test02', title: 'T', status: 'planned', priority: 'normal', project: 'ENG' })
    const { ctx, captured } = makePutCtx(card.id, { status: 'done', assigned_to: 'dave', tags: ['x'] })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(400)
    const parsed = JSON.parse(captured.body)
    expect(parsed.unknown).toContain('assigned_to')
    expect(parsed.unknown).toContain('tags')
    expect(parsed.unknown).not.toContain('status')
  })

  it('accepts all known fields without error', async () => {
    const card = createCard({ id: 'test03', title: 'T', status: 'planned', priority: 'normal', project: 'ENG' })
    const { ctx, captured } = makePutCtx(card.id, {
      title: 'Updated',
      description: 'desc',
      status: 'in_progress',
      assignee: 'dave',
      priority: 'high',
      project: 'ENG',
      due_date: null,
      sort_order: 999,
      depends_on: null,
      parent_id: null,
    })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(200)
    expect(JSON.parse(captured.body)).toEqual({ ok: true })
  })

  it('regression: status-only update still works', async () => {
    const card = createCard({ id: 'test04', title: 'T', status: 'planned', priority: 'normal', project: 'ENG' })
    const { ctx, captured } = makePutCtx(card.id, { status: 'done' })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(200)
  })

  it('regression: description update still works', async () => {
    const card = createCard({ id: 'test05', title: 'T', status: 'planned', priority: 'normal', project: 'ENG' })
    const { ctx, captured } = makePutCtx(card.id, { description: 'new desc' })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(200)
  })

  it('does NOT mutate the card when an unknown field is present', async () => {
    const card = createCard({ id: 'test06', title: 'Original', status: 'planned', priority: 'normal', project: 'ENG' })
    const { ctx } = makePutCtx(card.id, { title: 'Changed', unknownField: 'x' })
    await tryHandleKanban(ctx)
    // Title must still be 'Original' -- the whole request was rejected
    const db = getNoaDb()
    const row = db.prepare('SELECT title FROM kanban_cards WHERE id = ?').get(card.id) as { title: string }
    expect(row.title).toBe('Original')
  })
})
