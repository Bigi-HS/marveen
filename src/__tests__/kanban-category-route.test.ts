import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Readable } from 'node:stream'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import { createCard, getCard, applyKanbanMigrations } from '../noa-kanban.js'
import { tryHandleKanban } from '../web/routes/kanban.js'

// Route-layer contract for the category enforcement (card cf0d1bfe):
// CREATE is strict (missing/null/empty/out-of-enum -> 400), UPDATE is graceful
// (a category-less update of a legacy card is NOT a 400). Complements the core
// unit tests in kanban-category.test.ts.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
  applyKanbanMigrations()
})

beforeEach(() => {
  getNoaDb().exec('DELETE FROM kanban_cards')
})

interface Captured { status: number; body: unknown }

async function call(method: string, path: string, payload: unknown): Promise<Captured> {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]) as unknown as import('http').IncomingMessage
  const captured: Captured = { status: 0, body: undefined }
  const res = {
    writeHead(status: number) { captured.status = status; return this },
    end(chunk?: string) { if (chunk) captured.body = JSON.parse(chunk) },
  } as unknown as import('http').ServerResponse
  const handled = await tryHandleKanban({
    req, res, path, method,
    url: new URL('http://x' + path),
    identity: { agentId: 'dave', scopes: [] } as never,
  })
  expect(handled).toBe(true)
  return captured
}

describe('POST /api/kanban category enforcement (strict)', () => {
  it('rejects a create with no category (400)', async () => {
    const r = await call('POST', '/api/kanban', { title: 'x' })
    expect(r.status).toBe(400)
  })

  it('rejects null / empty / whitespace category (400)', async () => {
    for (const category of [null, '', '   ']) {
      const r = await call('POST', '/api/kanban', { title: 'x', category })
      expect(r.status).toBe(400)
    }
  })

  it('rejects an out-of-enum category incl. combined/separator values (400)', async () => {
    for (const category of ['FOO', 'DASHBOARD', 'CORE_MEM', 'CONT-BIGI', 'DASH ENG', 'DASH,ENG', 'DASH|ENG', 'CARE']) {
      const r = await call('POST', '/api/kanban', { title: 'x', category })
      expect(r.status).toBe(400)
    }
  })

  it('accepts a valid category (normalized) and stores it', async () => {
    const r = await call('POST', '/api/kanban', { title: 'x', category: 'dash' })
    expect(r.status).toBe(200)
    const id = (r.body as { id: string }).id
    expect(getCard(id)!.category).toBe('DASH')
    expect(getCard(id)!.card_code).toBe(`DASH-${id}`)
  })
})

describe('PUT /api/kanban/:id category (graceful)', () => {
  it('updates a legacy category-less card WITHOUT category -> 200, not 400', async () => {
    createCard({ id: 'legrt001', title: 'legacy' })
    const r = await call('PUT', '/api/kanban/legrt001', { title: 'legacy renamed' })
    expect(r.status).toBe(200)
    expect(getCard('legrt001')!.title).toBe('legacy renamed')
    expect(getCard('legrt001')!.category).toBeNull()
  })

  it('rejects an update that supplies an out-of-enum category (400)', async () => {
    createCard({ id: 'legrt002', title: 'x' })
    const r = await call('PUT', '/api/kanban/legrt002', { category: 'CARE' })
    expect(r.status).toBe(400)
  })
})
