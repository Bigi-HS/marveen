// TDD: GET /api/kanban?status=... backend filter (SEC debt 2ab684f3)
// Before: route returned ALL cards, client filtered. After: backend honours ?status= param.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import { createCard, configureKanban, invalidateColumnsCache } from '../noa-kanban.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { AgentIdentity } from '../web/agent-token-registry.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

const AGENT: AgentIdentity = { agentId: 'dave', scopes: [], source: 'agent' }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
  configureKanban({ isRunning: () => false, agentNames: [] })
})

function wipe() {
  getNoaDb().prepare('DELETE FROM kanban_cards').run()
  invalidateColumnsCache()
}

beforeEach(wipe)
afterEach(wipe)

async function kanbanGet(path: string): Promise<{ status: number; body: unknown[] }> {
  const url = new URL('http://x' + path)
  const req = Object.assign(Readable.from([]), {
    socket: { remoteAddress: '127.0.0.1' },
  }) as never
  let captured: { status: number; body: unknown[] } = { status: 200, body: [] }
  const res = {
    writeHead(s: number) { captured.status = s; return res },
    end(b?: string) { if (b) captured.body = JSON.parse(b) },
  } as never
  await tryHandleKanban({ req, res, method: 'GET', path: url.pathname, url, identity: AGENT } as never)
  return captured
}

describe('GET /api/kanban status filter', () => {
  it('without filter default-excludes done/icebox cards', async () => {
    createCard({ title: 'P1', status: 'planned', priority: 'normal' })
    createCard({ title: 'D1', status: 'done', priority: 'normal' })
    const r = await kanbanGet('/api/kanban')
    // New contract (fd95a6e6): no status param -> exclude done/icebox to keep the
    // query small and avoid blocking the event loop on a full-board scan.
    expect((r.body as { title: string }[]).map(c => c.title)).toContain('P1')
    expect((r.body as { title: string }[]).map(c => c.title)).not.toContain('D1')
  })

  it('?status=planned returns only planned cards', async () => {
    createCard({ title: 'P1', status: 'planned', priority: 'normal' })
    createCard({ title: 'D1', status: 'done', priority: 'normal' })
    const r = await kanbanGet('/api/kanban?status=planned')
    const titles = (r.body as { title: string }[]).map(c => c.title)
    expect(titles).toContain('P1')
    expect(titles).not.toContain('D1')
  })

  it('?status=in_progress returns only in_progress cards', async () => {
    createCard({ title: 'IP1', status: 'in_progress', priority: 'normal' })
    createCard({ title: 'P1', status: 'planned', priority: 'normal' })
    const r = await kanbanGet('/api/kanban?status=in_progress')
    const titles = (r.body as { title: string }[]).map(c => c.title)
    expect(titles).toContain('IP1')
    expect(titles).not.toContain('P1')
  })

  it('empty ?status= (blank) returns all cards (no filter applied)', async () => {
    createCard({ title: 'P1', status: 'planned', priority: 'normal' })
    createCard({ title: 'D1', status: 'done', priority: 'normal' })
    const r = await kanbanGet('/api/kanban?status=')
    const titles = (r.body as { title: string }[]).map(c => c.title)
    expect(titles).toContain('P1')
    expect(titles).toContain('D1')
  })
})
