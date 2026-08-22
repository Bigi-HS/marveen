import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { tryHandleBondSrs, computeSrsDue, parseTopN } from '../web/routes/bond-srs.js'

const TEST_DB = '/tmp/test-bond-srs.db'

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

// Seed an in-memory (or file) Bond vocab DB mirroring the real schema. `dueOffsets`
// are seconds relative to now for each word's review_due_epoch (negative = due).
function seed(db: Database.Database, words: Array<{ word: string; dueOffset: number }>, sessions: Array<{ ended: number; turns: number }>) {
  db.exec(`CREATE TABLE vocab (id INTEGER PRIMARY KEY, word TEXT, context_sentence TEXT, review_due_epoch INTEGER, interval_days INTEGER);
           CREATE TABLE sessions (id INTEGER PRIMARY KEY, started_at INTEGER, ended_at INTEGER, type TEXT, turn_count INTEGER, format_cycle INTEGER);`)
  const now = Math.floor(Date.now() / 1000)
  const iv = db.prepare('INSERT INTO vocab (word, review_due_epoch, interval_days) VALUES (?, ?, 1)')
  for (const w of words) iv.run(w.word, now + w.dueOffset)
  const is = db.prepare('INSERT INTO sessions (ended_at, turn_count) VALUES (?, ?)')
  for (const s of sessions) is.run(s.ended, s.turns)
}

async function call(method: string, fullPath: string) {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from([]) as never
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return res
    },
    end(b?: string) {
      captured.body = b ? JSON.parse(b) : undefined
    },
  } as never
  const handled = await tryHandleBondSrs({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

beforeEach(cleanDb)
afterAll(() => {
  cleanDb()
  delete process.env.BOND_DB_PATH
})

describe('parseTopN', () => {
  it('defaults to 3 for missing/invalid', () => {
    expect(parseTopN(null)).toBe(3)
    expect(parseTopN('abc')).toBe(3)
  })
  it('clamps into [1, 10]', () => {
    expect(parseTopN('0')).toBe(1)
    expect(parseTopN('-5')).toBe(1)
    expect(parseTopN('7')).toBe(7)
    expect(parseTopN('99')).toBe(10)
  })
})

describe('computeSrsDue -- aggregation', () => {
  it('counts only due words and returns the earliest-due first, capped at top_n', () => {
    const db = new Database(':memory:')
    seed(
      db,
      [
        { word: 'overcome', dueOffset: -3000 },
        { word: 'withstand', dueOffset: -2000 },
        { word: 'forecast', dueOffset: -1000 },
        { word: 'notdueyet', dueOffset: 10000 },
      ],
      [{ ended: Math.floor(Date.now() / 1000) - 7200, turns: 8 }],
    )
    const r = computeSrsDue(db, 3)
    expect(r.due_count).toBe(3)
    expect(r.top_words).toEqual(['overcome', 'withstand', 'forecast'])
    expect(r.hours_since_session).toBe(2)
    expect(r.last_session_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    db.close()
  })

  it('returns due_count 0 and empty top_words when nothing is due', () => {
    const db = new Database(':memory:')
    seed(db, [{ word: 'later', dueOffset: 99999 }], [])
    const r = computeSrsDue(db, 3)
    expect(r.due_count).toBe(0)
    expect(r.top_words).toEqual([])
    db.close()
  })

  it('ignores sessions with fewer than 5 turns for recency', () => {
    const db = new Database(':memory:')
    const now = Math.floor(Date.now() / 1000)
    seed(db, [{ word: 'w', dueOffset: -1 }], [
      { ended: now - 3600, turns: 2 }, // too short -> ignored
      { ended: now - 36000, turns: 9 }, // qualifying
    ])
    const r = computeSrsDue(db, 3)
    expect(r.hours_since_session).toBe(10)
    db.close()
  })

  it('yields null recency fields when no qualifying session exists', () => {
    const db = new Database(':memory:')
    seed(db, [{ word: 'w', dueOffset: -1 }], [{ ended: Math.floor(Date.now() / 1000), turns: 1 }])
    const r = computeSrsDue(db, 3)
    expect(r.hours_since_session).toBeNull()
    expect(r.last_session_date).toBeNull()
    db.close()
  })
})

describe('GET /api/bond/srs-due-count -- routing & errors', () => {
  it('does not handle unrelated paths or non-GET methods', async () => {
    expect((await call('GET', '/api/bond/other')).handled).toBe(false)
    expect((await call('POST', '/api/bond/srs-due-count')).handled).toBe(false)
  })

  it('returns 503 bond_db_unavailable when the DB file is missing', async () => {
    process.env.BOND_DB_PATH = '/tmp/does-not-exist-bond.db'
    const r = await call('GET', '/api/bond/srs-due-count')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('bond_db_unavailable')
  })

  it('serves a 200 summary from a real (file) DB honoring top_n', async () => {
    const db = new Database(TEST_DB)
    seed(
      db,
      [
        { word: 'alpha', dueOffset: -300 },
        { word: 'beta', dueOffset: -200 },
        { word: 'gamma', dueOffset: -100 },
      ],
      [{ ended: Math.floor(Date.now() / 1000) - 3600, turns: 6 }],
    )
    db.close()
    process.env.BOND_DB_PATH = TEST_DB
    const r = await call('GET', '/api/bond/srs-due-count?top_n=2')
    expect(r.status).toBe(200)
    expect(r.body.due_count).toBe(3)
    expect(r.body.top_words).toEqual(['alpha', 'beta'])
    expect(r.body.hours_since_session).toBe(1)
  })
})
