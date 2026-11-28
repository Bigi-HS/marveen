// Write-path validation/normalization of parked_until (card 0a1c5102, part a).
//
// Root cause: card 9cf177d4 had parked_until stored as the STRING '2027-02-01'
// instead of an epoch int. The autopilot tick-driver compares parked_until
// against now-epoch (SECONDS); a non-numeric string fails the parsed-epoch check
// -> the card is treated as UNPARKED -> false stale-nudges every tick.
//
// Fix (write-path): POST /api/kanban and PUT /api/kanban/:id coerce an ISO date
// string (YYYY-MM-DD or full ISO datetime) to an epoch-SECONDS integer, accept an
// already-epoch int unchanged, keep null/absent untouched, and reject any
// non-coercible value with HTTP 400. A non-epoch value is never persisted.
//
// Units are epoch SECONDS, matching the readers: noa-kanban isStale()
// (`card.parked_until > nowSec`) and kanban-sla.ts (`row.parked_until > nowSec`).

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { seedTestAgents } from './_fk-test-agents.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import { createCard, configureKanban, invalidateColumnsCache } from '../noa-kanban.js'
import { tryHandleKanban, coerceParkedUntil, InvalidParkedUntilError } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

// 2027-02-01T00:00:00Z as epoch seconds (UTC-midnight parse of 'YYYY-MM-DD').
const EPOCH_2027_02_01_UTC = Math.floor(Date.parse('2027-02-01') / 1000)

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
  seedTestAgents(getNoaDb())
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
// Minimal HTTP mock -- enough for tryHandleKanban (mirrors kanban-put-unknown-field)
// ---------------------------------------------------------------------------

function makeCtx(method: 'POST' | 'PUT', path: string, body: Record<string, unknown>): { ctx: RouteContext; captured: { status: number; body: string } } {
  const bodyStr = JSON.stringify(body)
  const captured = { status: 200, body: '' }

  const req = Object.assign(Readable.from([Buffer.from(bodyStr)]), {
    method,
    headers: { 'content-length': String(Buffer.byteLength(bodyStr)) },
  }) as unknown as IncomingMessage

  const res = {
    writeHead(status: number) { captured.status = status },
    end(data: string) { captured.body = data },
  } as unknown as ServerResponse

  const url = new URL(`http://localhost${path}`)
  const ctx: RouteContext = { req, res, path, method, url, identity: null as never }
  return { ctx, captured }
}

function readParkedUntil(id: string): unknown {
  const row = getNoaDb().prepare('SELECT parked_until FROM kanban_cards WHERE id = ?').get(id) as { parked_until: unknown }
  return row.parked_until
}

// ===========================================================================
// Pure helper (coerceParkedUntil)
// ===========================================================================

describe('coerceParkedUntil (card 0a1c5102)', () => {
  it('coerces a YYYY-MM-DD string to epoch seconds', () => {
    expect(coerceParkedUntil('2027-02-01')).toBe(EPOCH_2027_02_01_UTC)
    expect(typeof coerceParkedUntil('2027-02-01')).toBe('number')
  })

  it('coerces a full ISO datetime string to epoch seconds', () => {
    const iso = '2027-02-01T09:00:00Z'
    expect(coerceParkedUntil(iso)).toBe(Math.floor(Date.parse(iso) / 1000))
  })

  it('passes an already-epoch int through unchanged', () => {
    expect(coerceParkedUntil(1801468800)).toBe(1801468800)
  })

  it('accepts a bare integer string as epoch seconds', () => {
    expect(coerceParkedUntil('1801468800')).toBe(1801468800)
  })

  it('returns null for null and undefined for undefined', () => {
    expect(coerceParkedUntil(null)).toBeNull()
    expect(coerceParkedUntil(undefined)).toBeUndefined()
  })

  it('throws on a garbage non-coercible string', () => {
    expect(() => coerceParkedUntil('soon')).toThrow(InvalidParkedUntilError)
    expect(() => coerceParkedUntil('not-a-date')).toThrow(InvalidParkedUntilError)
  })

  it('throws on an epoch-MILLIS value (out of seconds window)', () => {
    expect(() => coerceParkedUntil(1801468800000)).toThrow(InvalidParkedUntilError)
  })

  it('throws on a non-integer / non-finite number', () => {
    expect(() => coerceParkedUntil(1.5)).toThrow(InvalidParkedUntilError)
    expect(() => coerceParkedUntil(NaN)).toThrow(InvalidParkedUntilError)
  })
})

// ===========================================================================
// POST /api/kanban (create)
// ===========================================================================

describe('POST /api/kanban -- parked_until normalization (card 0a1c5102)', () => {
  it('coerces a YYYY-MM-DD string to an epoch int on create', async () => {
    const { ctx, captured } = makeCtx('POST', '/api/kanban', {
      title: 'parked', status: 'planned', priority: 'normal', project: 'ENG',
      parked_until: '2027-02-01',
    })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(200)
    const { id } = JSON.parse(captured.body)
    const stored = readParkedUntil(id)
    expect(stored).toBe(EPOCH_2027_02_01_UTC)
    expect(Number.isInteger(stored)).toBe(true)
  })

  it('coerces a full ISO datetime string on create', async () => {
    const iso = '2027-02-01T09:00:00Z'
    const { ctx, captured } = makeCtx('POST', '/api/kanban', {
      title: 'parked', status: 'planned', priority: 'normal', project: 'ENG',
      parked_until: iso,
    })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(200)
    const { id } = JSON.parse(captured.body)
    expect(readParkedUntil(id)).toBe(Math.floor(Date.parse(iso) / 1000))
  })

  it('stores an already-epoch int unchanged on create', async () => {
    const { ctx, captured } = makeCtx('POST', '/api/kanban', {
      title: 'parked', status: 'planned', priority: 'normal', project: 'ENG',
      parked_until: 1801468800,
    })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(200)
    const { id } = JSON.parse(captured.body)
    expect(readParkedUntil(id)).toBe(1801468800)
  })

  it('rejects a garbage parked_until with 400 (nothing persisted)', async () => {
    const { ctx, captured } = makeCtx('POST', '/api/kanban', {
      title: 'parked', status: 'planned', priority: 'normal', project: 'ENG',
      parked_until: 'soon',
    })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(400)
    expect(JSON.parse(captured.body).error).toMatch(/parked_until/)
    // No card should have been created.
    const count = getNoaDb().prepare('SELECT COUNT(*) AS n FROM kanban_cards').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('leaves parked_until null when absent on create', async () => {
    const { ctx, captured } = makeCtx('POST', '/api/kanban', {
      title: 'unparked', status: 'planned', priority: 'normal', project: 'ENG',
    })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(200)
    const { id } = JSON.parse(captured.body)
    expect(readParkedUntil(id)).toBeNull()
  })

  it('stores null when parked_until is explicitly null on create', async () => {
    const { ctx, captured } = makeCtx('POST', '/api/kanban', {
      title: 'unparked', status: 'planned', priority: 'normal', project: 'ENG',
      parked_until: null,
    })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(200)
    const { id } = JSON.parse(captured.body)
    expect(readParkedUntil(id)).toBeNull()
  })
})

// ===========================================================================
// PUT /api/kanban/:id (update)
// ===========================================================================

describe('PUT /api/kanban/:id -- parked_until normalization (card 0a1c5102)', () => {
  it('coerces a YYYY-MM-DD string to an epoch int on update', async () => {
    const card = createCard({ id: 'put01', title: 'T', status: 'planned', priority: 'normal', project: 'ENG' })
    const { ctx, captured } = makeCtx('PUT', `/api/kanban/${card.id}`, { parked_until: '2027-02-01' })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(200)
    expect(readParkedUntil(card.id)).toBe(EPOCH_2027_02_01_UTC)
  })

  it('coerces a full ISO datetime string on update', async () => {
    const card = createCard({ id: 'put02', title: 'T', status: 'planned', priority: 'normal', project: 'ENG' })
    const iso = '2027-02-01T09:00:00Z'
    const { ctx, captured } = makeCtx('PUT', `/api/kanban/${card.id}`, { parked_until: iso })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(200)
    expect(readParkedUntil(card.id)).toBe(Math.floor(Date.parse(iso) / 1000))
  })

  it('stores an already-epoch int unchanged on update', async () => {
    const card = createCard({ id: 'put03', title: 'T', status: 'planned', priority: 'normal', project: 'ENG' })
    const { ctx, captured } = makeCtx('PUT', `/api/kanban/${card.id}`, { parked_until: 1801468800 })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(200)
    expect(readParkedUntil(card.id)).toBe(1801468800)
  })

  it('rejects a garbage parked_until with 400 and does not mutate the card', async () => {
    const card = createCard({ id: 'put04', title: 'T', status: 'planned', priority: 'normal', project: 'ENG', parked_until: 1801468800 })
    const { ctx, captured } = makeCtx('PUT', `/api/kanban/${card.id}`, { parked_until: '2027-02-01-broken' })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(400)
    expect(JSON.parse(captured.body).error).toMatch(/parked_until/)
    // Unchanged -- the original epoch value survives.
    expect(readParkedUntil(card.id)).toBe(1801468800)
  })

  it('clears parked_until when explicitly null on update (unpark)', async () => {
    const card = createCard({ id: 'put05', title: 'T', status: 'planned', priority: 'normal', project: 'ENG', parked_until: 1801468800 })
    const { ctx, captured } = makeCtx('PUT', `/api/kanban/${card.id}`, { parked_until: null })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(200)
    expect(readParkedUntil(card.id)).toBeNull()
  })

  it('leaves parked_until untouched when the field is absent from the PUT body', async () => {
    const card = createCard({ id: 'put06', title: 'T', status: 'planned', priority: 'normal', project: 'ENG', parked_until: 1801468800 })
    const { ctx, captured } = makeCtx('PUT', `/api/kanban/${card.id}`, { title: 'Renamed' })
    await tryHandleKanban(ctx)
    expect(captured.status).toBe(200)
    // parked_until is not in the body -> updateCard leaves the column as-is.
    expect(readParkedUntil(card.id)).toBe(1801468800)
  })
})
