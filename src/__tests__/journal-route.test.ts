// Tests for GET + POST /api/journal/entries (card 48bf3fcf, Phase 0C)
// TDD: network-free, in-memory SQLite DB seam.

import { describe, it, expect, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import Database from 'better-sqlite3'
import {
  tryHandleJournal,
  applyJournalMigrations,
  __setDbSeam,
} from '../web/routes/journal.js'
import type { AgentIdentity } from '../web/agent-token-registry.js'

const AUTH: AgentIdentity = { agentId: 'marveen', scopes: ['admin:*'], source: 'operator' }
const ANON: AgentIdentity = { agentId: '', scopes: [], source: 'agent' }

function makeMemDb() {
  const db = new Database(':memory:')
  applyJournalMigrations(db)
  return db
}

async function call(method: string, path: string, rawBody?: string, identity = AUTH) {
  const url = new URL('http://x' + path)
  const req = Readable.from(rawBody === undefined ? [] : [Buffer.from(rawBody)]) as never
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(s: number) { captured.status = s; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as never
  const handled = await tryHandleJournal({ req, res, method, path: url.pathname, url, identity } as never)
  return { handled, ...captured }
}

afterEach(() => __setDbSeam(null))

describe('route guard', () => {
  it('passes through unrelated paths', async () => {
    expect((await call('GET', '/api/kanban')).handled).toBe(false)
  })
})

describe('GET /api/journal/entries', () => {
  it('requires authentication', async () => {
    __setDbSeam(makeMemDb())
    const r = await call('GET', '/api/journal/entries', undefined, ANON)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(403)
  })

  it('returns empty array when no entries exist', async () => {
    __setDbSeam(makeMemDb())
    const r = await call('GET', '/api/journal/entries')
    expect(r.status).toBe(200)
    expect(r.body.entries).toEqual([])
  })

  it('returns entries in reverse chronological order', async () => {
    const db = makeMemDb()
    __setDbSeam(db)
    db.prepare('INSERT INTO journal_entries (content, mood, tags, created_at) VALUES (?,?,?,?)').run('first', null, null, 1000)
    db.prepare('INSERT INTO journal_entries (content, mood, tags, created_at) VALUES (?,?,?,?)').run('second', null, null, 2000)
    const r = await call('GET', '/api/journal/entries')
    expect(r.body.entries[0].content).toBe('second')
    expect(r.body.entries[1].content).toBe('first')
  })

  it('respects ?limit query param', async () => {
    const db = makeMemDb()
    __setDbSeam(db)
    for (let i = 0; i < 5; i++) {
      db.prepare('INSERT INTO journal_entries (content, created_at) VALUES (?,?)').run(`entry${i}`, i)
    }
    const r = await call('GET', '/api/journal/entries?limit=2')
    expect(r.body.entries).toHaveLength(2)
  })

  it('defaults to limit=20', async () => {
    const db = makeMemDb()
    __setDbSeam(db)
    for (let i = 0; i < 25; i++) {
      db.prepare('INSERT INTO journal_entries (content, created_at) VALUES (?,?)').run(`e${i}`, i)
    }
    const r = await call('GET', '/api/journal/entries')
    expect(r.body.entries).toHaveLength(20)
  })
})

describe('POST /api/journal/entries', () => {
  it('requires authentication', async () => {
    __setDbSeam(makeMemDb())
    const r = await call('POST', '/api/journal/entries', '{}', ANON)
    expect(r.status).toBe(403)
  })

  it('rejects missing content with 400', async () => {
    __setDbSeam(makeMemDb())
    const r = await call('POST', '/api/journal/entries', JSON.stringify({ mood: 'happy' }))
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/content/i)
  })

  it('rejects invalid JSON with 400', async () => {
    __setDbSeam(makeMemDb())
    const r = await call('POST', '/api/journal/entries', '{bad')
    expect(r.status).toBe(400)
  })

  it('stores entry and returns 201 with id', async () => {
    const db = makeMemDb()
    __setDbSeam(db)
    const r = await call('POST', '/api/journal/entries', JSON.stringify({ content: 'Today was good', mood: 'happy', tags: 'personal' }))
    expect(r.status).toBe(201)
    expect(typeof r.body.id).toBe('number')
    expect(r.body.ok).toBe(true)
    const row = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(r.body.id) as any
    expect(row.content).toBe('Today was good')
    expect(row.mood).toBe('happy')
  })
})
