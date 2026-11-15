/**
 * Memory provenance guard tests (card 8ec56f1f)
 *
 * AC-3  classifyMemorySource unit table
 * AC-6  saveMemory throws UntrustedMemorySourceError on external-untrusted sources
 * AC-4  POST /api/memories route guard (HTTP 400 + guard event + no row written)
 * AC-5  Trusted write persists source, response echoes source
 * AC-9  Adversarial fixture table (>= 10 untrusted attempts + true-positive set)
 *       bypass classes: (a) casing/whitespace, (b) unknown string, (c) absent source,
 *                        (d) access_scope abuse, (e) direct saveMemory with untrusted
 * Migration idempotence: applyMemoryMigrations runs twice without error
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

// --- Module-level mocks (must come before the module under test is imported) ---

// noa-db mock: redirect getNoaDb to our in-memory fixture DB
vi.mock('../noa-db.js', () => {
  const _db: { db: Database.Database | null } = { db: null }
  return {
    getNoaDb: () => _db.db!,
    initNoaDb: () => {},
    __setDb: (db: Database.Database) => { _db.db = db },
  }
})

// Suppress Ollama calls in tests (embedding kick-off is fire-and-forget)
vi.mock('node-fetch', () => ({ default: vi.fn() }))

// guard-event-recorder mock: capture events for assertion
const capturedGuardEvents: Array<Record<string, unknown>> = []
vi.mock('../web/guard-event-recorder.js', () => ({
  recordGuardEvent: (ev: Record<string, unknown>) => { capturedGuardEvents.push(ev) },
}))

// agent-identity-binding mock
vi.mock('../web/agent-identity-binding.js', () => ({
  decideMemoryMutation: () => ({ ok: true }),
  enforceFromBindingEnabled: () => false,
}))

// agent-config mock
vi.mock('../web/agent-config.js', () => ({
  isKnownAgent: (id: string) => ['marveen', 'dave', 'thor'].includes(id),
}))

// config mock
vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  OLLAMA_URL: 'http://localhost:11434',
}))

// logger mock
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// http-helpers pass-through (actual impl is tiny; re-implement inline)
vi.mock('../web/http-helpers.js', () => ({
  readBody: async (req: IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk as unknown as ArrayBuffer))
    return Buffer.concat(chunks)
  },
  json: (res: ServerResponse, body: unknown, status = 200) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  },
}))

// --- Imports under test (after mocks) ---
import {
  classifyMemorySource,
  UntrustedMemorySourceError,
  saveMemory,
  applyMemoryMigrations,
} from '../noa-memory.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import * as noaDb from '../noa-db.js'

// __setDb is provided by the vi.mock factory above; access via the module namespace.
const __setDb = (noaDb as unknown as { __setDb: (db: Database.Database) => void }).__setDb

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SCHEMA_SQL = readFileSync(join(__dirname, '../../scripts/schema-noa.sql'), 'utf-8')

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // Execute schema (skip sqlite-vec extension lines that may not be available)
  const cleanedSql = SCHEMA_SQL
    .replace(/USING\s+vec_f32[^;]+;/gi, ';')
    .replace(/SELECT\s+vec_version\(\)[^;]+;/gi, '')
  try { db.exec(cleanedSql) } catch {}
  // Apply our migration (adds source column)
  applyMemoryMigrations(db)
  return db
}

function makeRouteCtx(method: string, path: string, body: unknown) {
  const bodyBuf = Buffer.from(JSON.stringify(body))
  let pos = 0
  const req = {
    method,
    url: `http://localhost:3420${path}`,
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () {
      if (pos === 0) { pos = 1; yield bodyBuf }
    },
  } as unknown as IncomingMessage

  const chunks: Buffer[] = []
  let status = 200
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (chunk: string) => { chunks.push(Buffer.from(chunk)); status = res.statusCode },
    get _body() { return JSON.parse(chunks.join('') || '{}') },
    get _status() { return status },
  } as unknown as ServerResponse & { _body: Record<string, unknown>; _status: number }

  const identity = { agentId: 'marveen', scopes: ['memory:write'], source: 'operator' as const }

  return { req, res, path, method, url: new URL(`http://localhost:3420${path}`), identity }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let db: Database.Database

beforeEach(() => {
  db = makeDb()
  ;(__setDb as (d: Database.Database) => void)(db)
  capturedGuardEvents.length = 0
})

afterEach(() => {
  db.close()
})

// ---------------------------------------------------------------------------
// AC-3  classifyMemorySource unit table
// ---------------------------------------------------------------------------

describe('classifyMemorySource', () => {
  it.each([
    ['user', 'trusted'],
    ['agent-self', 'trusted'],
    ['system', 'trusted'],
    // (a) casing/whitespace normalisation
    ['User', 'trusted'],
    ['  user  ', 'trusted'],
    ['AGENT-SELF', 'trusted'],
    ['System', 'trusted'],
    // untrusted external sources
    ['email', 'untrusted'],
    ['web', 'untrusted'],
    ['calendar', 'untrusted'],
    ['inter-agent', 'untrusted'],
    ['legacy', 'untrusted'],
    // (b) unknown strings
    ['boss', 'untrusted'],
    ['trusted', 'untrusted'],
    ['external', 'untrusted'],
    // (c) absent / empty
    ['', 'untrusted'],
  ] as Array<[string, 'trusted' | 'untrusted']>)(
    'classifyMemorySource(%s) = %s',
    (src, expected) => {
      expect(classifyMemorySource(src)).toBe(expected)
    },
  )

  it('classifyMemorySource(null) = untrusted', () => {
    expect(classifyMemorySource(null)).toBe('untrusted')
  })

  it('classifyMemorySource(undefined) = untrusted', () => {
    expect(classifyMemorySource(undefined)).toBe('untrusted')
  })
})

// ---------------------------------------------------------------------------
// AC-6  saveMemory throws on external untrusted sources
// ---------------------------------------------------------------------------

describe('saveMemory source enforcement', () => {
  it.each(['email', 'web', 'calendar', 'inter-agent'] as const)(
    'saveMemory throws UntrustedMemorySourceError for source=%s',
    (src) => {
      expect(() =>
        saveMemory('marveen', 'test content', 'warm', undefined, undefined, src),
      ).toThrow(UntrustedMemorySourceError)
    },
  )

  it('saveMemory throws for unknown source string', () => {
    expect(() =>
      saveMemory('marveen', 'test content', 'warm', undefined, undefined, 'boss'),
    ).toThrow(UntrustedMemorySourceError)
  })

  it('saveMemory persists and returns source for trusted source=user', () => {
    const result = saveMemory('marveen', 'trusted content', 'warm', undefined, undefined, 'user')
    expect(result.source).toBe('user')
    const row = db.prepare('SELECT source FROM memories WHERE id = ?').get(result.id) as { source: string }
    expect(row.source).toBe('user')
  })

  it('saveMemory persists source=agent-self', () => {
    const result = saveMemory('marveen', 'agent content', 'warm', undefined, undefined, 'agent-self')
    expect(result.source).toBe('agent-self')
  })

  it('saveMemory persists source=system', () => {
    const result = saveMemory('marveen', 'system content', 'warm', undefined, undefined, 'system')
    expect(result.source).toBe('system')
  })

  it('saveMemory with legacy source does NOT throw (migration exemption AC-7)', () => {
    expect(() =>
      saveMemory('marveen', 'migration content', 'warm', undefined, undefined, 'legacy'),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC-4 + AC-9  Route guard: adversarial fixture table
// ---------------------------------------------------------------------------

describe('POST /api/memories route guard', () => {
  async function post(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown>; guardEvents: typeof capturedGuardEvents }> {
    capturedGuardEvents.length = 0
    const ctx = makeRouteCtx('POST', '/api/memories', body)
    await tryHandleMemories(ctx as unknown as Parameters<typeof tryHandleMemories>[0])
    const res = ctx.res as { _body: Record<string, unknown>; _status: number }
    return { status: res._status, body: res._body, guardEvents: [...capturedGuardEvents] }
  }

  function rowCount(): number {
    return (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c
  }

  // Adversarial attempts (AC-9): each must return 400 + BLOCK guard event + no row written

  it('rejects: source=email', async () => {
    const before = rowCount()
    const { status, body, guardEvents } = await post({ content: 'email content', source: 'email' })
    expect(status).toBe(400)
    expect(body.error).toBeTruthy()
    expect(rowCount()).toBe(before)
    const block = guardEvents.find(e => e.mechanism === 'memory-provenance' && e.verdict === 'BLOCK')
    expect(block).toBeTruthy()
  })

  it('rejects: source=web', async () => {
    const before = rowCount()
    const { status, guardEvents } = await post({ content: 'web content', source: 'web' })
    expect(status).toBe(400)
    expect(rowCount()).toBe(before)
    expect(guardEvents.some(e => e.mechanism === 'memory-provenance' && e.verdict === 'BLOCK')).toBe(true)
  })

  it('rejects: source=calendar', async () => {
    const before = rowCount()
    const { status, guardEvents } = await post({ content: 'cal event', source: 'calendar' })
    expect(status).toBe(400)
    expect(rowCount()).toBe(before)
    expect(guardEvents.some(e => e.mechanism === 'memory-provenance' && e.verdict === 'BLOCK')).toBe(true)
  })

  it('rejects: source=inter-agent', async () => {
    const before = rowCount()
    const { status, guardEvents } = await post({ content: 'msg', source: 'inter-agent' })
    expect(status).toBe(400)
    expect(rowCount()).toBe(before)
    expect(guardEvents.some(e => e.mechanism === 'memory-provenance' && e.verdict === 'BLOCK')).toBe(true)
  })

  it('rejects: source=legacy', async () => {
    const before = rowCount()
    const { status, guardEvents } = await post({ content: 'old content', source: 'legacy' })
    expect(status).toBe(400)
    expect(rowCount()).toBe(before)
    expect(guardEvents.some(e => e.mechanism === 'memory-provenance' && e.verdict === 'BLOCK')).toBe(true)
  })

  // (a) casing/whitespace bypass attempts
  it('rejects: source="Email" (casing bypass)', async () => {
    const before = rowCount()
    const { status, guardEvents } = await post({ content: 'email content', source: 'Email' })
    expect(status).toBe(400)
    expect(rowCount()).toBe(before)
    expect(guardEvents.some(e => e.mechanism === 'memory-provenance' && e.verdict === 'BLOCK')).toBe(true)
  })

  it('rejects: source=" user " (whitespace -- would be trusted after trim, but this tests that trim is applied to trust, not to bypass)', async () => {
    // " user " with leading/trailing space should be TRUSTED after normalisation
    const before = rowCount()
    const { status } = await post({ content: 'user content', source: ' user ' })
    // Trusted after trim -- should succeed
    expect(status).toBe(200)
    expect(rowCount()).toBe(before + 1)
  })

  it('rejects: source="USER" (upper-cased -- trusted after normalisation)', async () => {
    // "USER" normalises to "user" => trusted
    const before = rowCount()
    const { status } = await post({ content: 'USER content', source: 'USER' })
    expect(status).toBe(200)
    expect(rowCount()).toBe(before + 1)
  })

  // (b) unknown source string
  it('rejects: source="boss" (unknown string)', async () => {
    const before = rowCount()
    const { status, guardEvents } = await post({ content: 'boss content', source: 'boss' })
    expect(status).toBe(400)
    expect(rowCount()).toBe(before)
    expect(guardEvents.some(e => e.mechanism === 'memory-provenance' && e.verdict === 'BLOCK')).toBe(true)
  })

  it('rejects: source="trusted" (unknown -- not in the constant)', async () => {
    const before = rowCount()
    const { status, guardEvents } = await post({ content: 'trusted content', source: 'trusted' })
    expect(status).toBe(400)
    expect(rowCount()).toBe(before)
    expect(guardEvents.some(e => e.mechanism === 'memory-provenance' && e.verdict === 'BLOCK')).toBe(true)
  })

  // (c) absent source
  it('rejects: source field absent', async () => {
    const before = rowCount()
    const { status, guardEvents } = await post({ content: 'no source' })
    expect(status).toBe(400)
    expect(rowCount()).toBe(before)
    expect(guardEvents.some(e => e.mechanism === 'memory-provenance' && e.verdict === 'BLOCK')).toBe(true)
  })

  it('rejects: source=null', async () => {
    const before = rowCount()
    const { status, guardEvents } = await post({ content: 'null source', source: null })
    expect(status).toBe(400)
    expect(rowCount()).toBe(before)
    expect(guardEvents.some(e => e.mechanism === 'memory-provenance' && e.verdict === 'BLOCK')).toBe(true)
  })

  // (d) access_scope abuse (can't hide an untrusted write by providing a scope)
  it('rejects: untrusted source even with access_scope set', async () => {
    const before = rowCount()
    const { status, guardEvents } = await post({ content: 'scoped web content', source: 'web', access_scope: 'marveen' })
    expect(status).toBe(400)
    expect(rowCount()).toBe(before)
    expect(guardEvents.some(e => e.mechanism === 'memory-provenance' && e.verdict === 'BLOCK')).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // True-positive set: trusted sources must succeed and persist correctly
  // ---------------------------------------------------------------------------

  it('accepts: source=user -- row written, source echoed', async () => {
    const before = rowCount()
    const { status, body } = await post({ content: 'user memory', source: 'user' })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof body.id).toBe('number')
    expect(body.source).toBe('user')
    expect(rowCount()).toBe(before + 1)
    const row = db.prepare('SELECT source FROM memories WHERE id = ?').get(body.id as number) as { source: string }
    expect(row.source).toBe('user')
  })

  it('accepts: source=agent-self -- row written, source echoed', async () => {
    const before = rowCount()
    const { status, body } = await post({ content: 'agent content', source: 'agent-self' })
    expect(status).toBe(200)
    expect(body.source).toBe('agent-self')
    expect(rowCount()).toBe(before + 1)
  })

  it('accepts: source=system -- row written, source echoed', async () => {
    const before = rowCount()
    const { status, body } = await post({ content: 'system content', source: 'system' })
    expect(status).toBe(200)
    expect(body.source).toBe('system')
    expect(rowCount()).toBe(before + 1)
  })
})

// ---------------------------------------------------------------------------
// Migration idempotence
// ---------------------------------------------------------------------------

describe('applyMemoryMigrations idempotence', () => {
  it('runs twice without throwing', () => {
    const freshDb = new Database(':memory:')
    // minimal schema -- just the memories table (no source column yet)
    freshDb.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        keywords TEXT,
        topic_key TEXT,
        access_scope TEXT,
        embedding BLOB,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL
      )
    `)
    // First migration adds the column
    expect(() => applyMemoryMigrations(freshDb)).not.toThrow()
    const cols1 = (freshDb.pragma('table_info(memories)') as { name: string }[]).map(c => c.name)
    expect(cols1).toContain('source')

    // Second migration is idempotent (column already exists)
    expect(() => applyMemoryMigrations(freshDb)).not.toThrow()
    const cols2 = (freshDb.pragma('table_info(memories)') as { name: string }[]).map(c => c.name)
    expect(cols2.filter(c => c === 'source')).toHaveLength(1)

    // Existing rows get DEFAULT 'legacy'
    freshDb.prepare("INSERT INTO memories (agent_id, category, content, created_at, accessed_at) VALUES ('a','warm','test',1,1)").run()
    const row = freshDb.prepare('SELECT source FROM memories WHERE id = last_insert_rowid()').get() as { source: string }
    expect(row.source).toBe('legacy')

    freshDb.close()
  })

  it('applyMemoryMigrations on already-migrated schema (source column present) is a no-op', () => {
    // db from beforeEach already has source column
    expect(() => applyMemoryMigrations(db)).not.toThrow()
  })
})
