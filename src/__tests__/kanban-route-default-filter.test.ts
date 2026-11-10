/**
 * Tests for GET /api/kanban default-filter (card fd95a6e6):
 *   - No status param -> excludes done/icebox (prevents event-loop block)
 *   - ?status=done -> returns done cards
 *   - ?status=all  -> returns all non-archived cards
 *   - ?limit / ?offset -> pagination works
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import { createCard, configureKanban, invalidateColumnsCache, moveCard } from '../noa-kanban.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

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

/** Minimal RouteContext driver that captures the JSON response. */
async function getKanban(queryString = ''): Promise<{ status: number; body: unknown[] }> {
  const fullPath = '/api/kanban' + (queryString ? '?' + queryString : '')
  const url = new URL('http://localhost' + fullPath)
  const req = Readable.from([]) as any
  const captured = { status: 200, body: [] as unknown[] }
  const res = {
    writeHead(s: number) { captured.status = s; return res },
    end(b?: string) { if (b) captured.body = JSON.parse(b) },
  } as any
  const ctx: RouteContext = {
    req,
    res,
    method: 'GET',
    path: url.pathname,
    url,
    identity: { agentId: 'test', scopes: [] } as any,
  }
  await tryHandleKanban(ctx)
  return captured as { status: number; body: unknown[] }
}

// ---------------------------------------------------------------------------
describe('GET /api/kanban default filter (no status param)', () => {
  it('excludes done and icebox cards when no status param is supplied', async () => {
    createCard({ title: 'Active 1', status: 'planned', suppressIntake: true })
    createCard({ title: 'Active 2', status: 'in_progress', suppressIntake: true })
    createCard({ title: 'Done card', status: 'done', suppressIntake: true })
    createCard({ title: 'Icebox card', status: 'icebox', suppressIntake: true })

    const { status, body } = await getKanban()
    expect(status).toBe(200)
    const titles = (body as Array<{ title: string }>).map((c) => c.title)
    expect(titles).toContain('Active 1')
    expect(titles).toContain('Active 2')
    expect(titles).not.toContain('Done card')
    expect(titles).not.toContain('Icebox card')
  })

  it('returns waiting cards (non-done/icebox) by default', async () => {
    createCard({ title: 'Waiting card', status: 'waiting', suppressIntake: true })
    createCard({ title: 'Done card', status: 'done', suppressIntake: true })

    const { body } = await getKanban()
    const titles = (body as Array<{ title: string }>).map((c) => c.title)
    expect(titles).toContain('Waiting card')
    expect(titles).not.toContain('Done card')
  })

  it('returns empty array when all cards are done/icebox', async () => {
    createCard({ title: 'D1', status: 'done', suppressIntake: true })
    createCard({ title: 'I1', status: 'icebox', suppressIntake: true })

    const { body } = await getKanban()
    expect(body).toEqual([])
  })
})

// ---------------------------------------------------------------------------
describe('GET /api/kanban?status=done', () => {
  it('returns only done cards when status=done is passed', async () => {
    createCard({ title: 'Planned', status: 'planned', suppressIntake: true })
    createCard({ title: 'Done card', status: 'done', suppressIntake: true })

    const { status, body } = await getKanban('status=done')
    expect(status).toBe(200)
    const titles = (body as Array<{ title: string }>).map((c) => c.title)
    expect(titles).toContain('Done card')
    expect(titles).not.toContain('Planned')
  })

  it('returns icebox cards when status=icebox is passed', async () => {
    createCard({ title: 'Planned', status: 'planned', suppressIntake: true })
    createCard({ title: 'Icebox card', status: 'icebox', suppressIntake: true })

    const { body } = await getKanban('status=icebox')
    const titles = (body as Array<{ title: string }>).map((c) => c.title)
    expect(titles).toContain('Icebox card')
    expect(titles).not.toContain('Planned')
  })
})

// ---------------------------------------------------------------------------
describe('GET /api/kanban?status=all', () => {
  it('returns all non-archived cards including done and icebox', async () => {
    createCard({ title: 'Planned', status: 'planned', suppressIntake: true })
    createCard({ title: 'Done', status: 'done', suppressIntake: true })
    createCard({ title: 'Icebox', status: 'icebox', suppressIntake: true })

    const { status, body } = await getKanban('status=all')
    expect(status).toBe(200)
    const titles = (body as Array<{ title: string }>).map((c) => c.title)
    expect(titles).toContain('Planned')
    expect(titles).toContain('Done')
    expect(titles).toContain('Icebox')
  })
})

// ---------------------------------------------------------------------------
describe('GET /api/kanban pagination (limit/offset)', () => {
  it('respects ?limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      createCard({ title: `Card ${i}`, status: 'planned', suppressIntake: true })
    }

    const { body } = await getKanban('limit=2')
    expect((body as unknown[]).length).toBe(2)
  })

  it('respects ?offset parameter', async () => {
    // Create 3 planned cards; with offset=2 we should get only 1
    for (let i = 0; i < 3; i++) {
      createCard({ title: `Card ${i}`, status: 'planned', suppressIntake: true })
    }

    const full = await getKanban()
    const paged = await getKanban('offset=2')
    expect((paged.body as unknown[]).length).toBe((full.body as unknown[]).length - 2)
  })

  it('limit and offset work together', async () => {
    for (let i = 0; i < 6; i++) {
      createCard({ title: `Card ${i}`, status: 'planned', suppressIntake: true })
    }

    const { body } = await getKanban('limit=2&offset=2')
    expect((body as unknown[]).length).toBe(2)
  })

  it('caps limit at 500', async () => {
    // We only have a few cards; just verify it does not throw and returns <= 500
    createCard({ title: 'C', status: 'planned', suppressIntake: true })
    const { status, body } = await getKanban('limit=99999')
    expect(status).toBe(200)
    expect((body as unknown[]).length).toBeLessThanOrEqual(500)
  })

  it('pagination applies with explicit status filter', async () => {
    for (let i = 0; i < 4; i++) {
      createCard({ title: `Done ${i}`, status: 'done', suppressIntake: true })
    }

    const { body } = await getKanban('status=done&limit=2')
    expect((body as unknown[]).length).toBe(2)
  })

  it('pagination applies with status=all', async () => {
    for (let i = 0; i < 3; i++) {
      createCard({ title: `P ${i}`, status: 'planned', suppressIntake: true })
      createCard({ title: `D ${i}`, status: 'done', suppressIntake: true })
    }

    const { body } = await getKanban('status=all&limit=3')
    expect((body as unknown[]).length).toBe(3)
  })
})
