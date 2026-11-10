// Tests for Phase 3C: RPG backend (card 71d8c9ba).
// TDD: written before implementation.
// Covers: DB migrations, level math, streak logic, GET /api/rpg/stats, POST /api/rpg/xp.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import Database from 'better-sqlite3'
import {
  applyRpgMigrations,
  computeLevel,
  computeStreak,
  tryHandleRpg,
  RPG_XP_SOURCES,
  __setDbSeam,
  type RpgDb,
} from '../web/routes/rpg.js'
import type { AgentIdentity } from '../web/agent-token-registry.js'

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

const AUTH: AgentIdentity = { agentId: 'marveen', scopes: ['admin:*'], source: 'operator' }
const ANON: AgentIdentity = { agentId: '', scopes: [], source: 'agent' }

// ---------------------------------------------------------------------------
// HTTP call helper
// ---------------------------------------------------------------------------

async function call(
  method: string,
  path: string,
  identity: AgentIdentity = AUTH,
  body: unknown = {},
) {
  const bodyStr = JSON.stringify(body)
  const req = Object.assign(Readable.from([Buffer.from(bodyStr)]), {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'content-type': 'application/json' },
  }) as never

  const captured: { status: number; body: unknown } = { status: 200, body: undefined }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    setHeader: () => res,
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as never

  const handled = await tryHandleRpg({ req, res, method, path, identity } as never)
  return { handled, ...captured }
}

// ---------------------------------------------------------------------------
// In-memory DB seam
// ---------------------------------------------------------------------------

function makeInMemoryDb(): RpgDb {
  const db = new Database(':memory:')
  applyRpgMigrations(db)

  return {
    insertXpEvent(source, amount, description, earnedAt, date) {
      db.prepare(
        'INSERT INTO xp_events (source, amount, description, earned_at, date) VALUES (?, ?, ?, ?, ?)',
      ).run(source, amount, description, earnedAt, date)
    },
    getTotalXp() {
      return (db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM xp_events').get() as { total: number }).total
    },
    getEventDates() {
      return (db.prepare('SELECT DISTINCT date FROM xp_events ORDER BY date DESC LIMIT 400').all() as { date: string }[]).map(r => r.date)
    },
    getTodayEventCount(date) {
      return (db.prepare('SELECT COUNT(*) AS cnt FROM xp_events WHERE date = ?').get(date) as { cnt: number }).cnt
    },
    insertAchievement(id, title, unlockedAt) {
      db.prepare('INSERT OR IGNORE INTO achievements (id, title, unlocked_at) VALUES (?, ?, ?)').run(id, title, unlockedAt)
    },
    getAchievements() {
      return db.prepare('SELECT id, title, unlocked_at FROM achievements ORDER BY unlocked_at DESC LIMIT 20').all() as Array<{ id: string; title: string; unlocked_at: number }>
    },
  }
}

afterEach(() => {
  __setDbSeam(null)
})

// ---------------------------------------------------------------------------
// 1. DB schema
// ---------------------------------------------------------------------------

describe('applyRpgMigrations', () => {
  it('creates xp_events table', () => {
    const db = new Database(':memory:')
    applyRpgMigrations(db)
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='xp_events'").get()
    expect(row).toBeTruthy()
  })

  it('creates achievements table', () => {
    const db = new Database(':memory:')
    applyRpgMigrations(db)
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='achievements'").get()
    expect(row).toBeTruthy()
  })

  it('is idempotent (run twice without error)', () => {
    const db = new Database(':memory:')
    applyRpgMigrations(db)
    expect(() => applyRpgMigrations(db)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 2. Level math
// ---------------------------------------------------------------------------

describe('computeLevel', () => {
  // Level thresholds: L2=100, L3=300, L4=600, L5=1000, Ln=50*n*(n-1)
  it('level 1 at 0 XP', () => { expect(computeLevel(0).level).toBe(1) })
  it('level 1 at 99 XP', () => { expect(computeLevel(99).level).toBe(1) })
  it('level 2 at exactly 100 XP', () => { expect(computeLevel(100).level).toBe(2) })
  it('level 2 at 299 XP', () => { expect(computeLevel(299).level).toBe(2) })
  it('level 3 at 300 XP', () => { expect(computeLevel(300).level).toBe(3) })
  it('level 4 at 600 XP', () => { expect(computeLevel(600).level).toBe(4) })
  it('level 5 at 1000 XP', () => { expect(computeLevel(1000).level).toBe(5) })

  it('xpInLevel: 50 XP above L2 threshold', () => {
    // L2 starts at 100; have 150 → 50 xpInLevel
    expect(computeLevel(150).xpInLevel).toBe(50)
  })

  it('xpForNextLevel equals level * 100', () => {
    // L2 → L3 requires 200 XP more (level=2, next step=100*2)
    expect(computeLevel(150).xpForNextLevel).toBe(200)
  })

  it('xpInLevel is 0 exactly on threshold', () => {
    expect(computeLevel(600).xpInLevel).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Streak calculation
// ---------------------------------------------------------------------------

describe('computeStreak', () => {
  it('returns 0 for empty date list', () => {
    expect(computeStreak([], '2026-11-10')).toBe(0)
  })

  it('returns 1 when only today has events', () => {
    expect(computeStreak(['2026-11-10'], '2026-11-10')).toBe(1)
  })

  it('returns 0 when last event was 2 days ago', () => {
    expect(computeStreak(['2026-11-08'], '2026-11-10')).toBe(0)
  })

  it('counts consecutive days ending today', () => {
    expect(computeStreak(['2026-11-10', '2026-11-09', '2026-11-08'], '2026-11-10')).toBe(3)
  })

  it('counts consecutive days ending yesterday (streak still alive)', () => {
    expect(computeStreak(['2026-11-09', '2026-11-08', '2026-11-07'], '2026-11-10')).toBe(3)
  })

  it('breaks on gap', () => {
    expect(computeStreak(['2026-11-10', '2026-11-07', '2026-11-06'], '2026-11-10')).toBe(1)
  })

  it('breaks when last event was yesterday, then gap', () => {
    expect(computeStreak(['2026-11-09', '2026-11-07'], '2026-11-10')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 4. RPG_XP_SOURCES whitelist
// ---------------------------------------------------------------------------

describe('RPG_XP_SOURCES', () => {
  it('has at least 5 sources', () => {
    expect(Object.keys(RPG_XP_SOURCES).length).toBeGreaterThanOrEqual(5)
  })

  it('workout_checkin gives 50 XP', () => {
    expect(RPG_XP_SOURCES['workout_checkin']?.amount).toBe(50)
  })

  it('kanban_done gives 25 XP', () => {
    expect(RPG_XP_SOURCES['kanban_done']?.amount).toBe(25)
  })

  it('all sources have positive amount and a label', () => {
    for (const [, v] of Object.entries(RPG_XP_SOURCES)) {
      expect(v.amount).toBeGreaterThan(0)
      expect(typeof v.label).toBe('string')
    }
  })
})

// ---------------------------------------------------------------------------
// 5. POST /api/rpg/xp
// ---------------------------------------------------------------------------

describe('POST /api/rpg/xp', () => {
  beforeEach(() => { __setDbSeam(makeInMemoryDb()) })

  it('passes through unrelated path', async () => {
    const r = await call('GET', '/api/other/path')
    expect(r.handled).toBe(false)
  })

  it('returns 403 without auth', async () => {
    const r = await call('POST', '/api/rpg/xp', ANON, { source: 'workout_checkin' })
    expect(r.status).toBe(403)
  })

  it('returns 400 for unknown source', async () => {
    const r = await call('POST', '/api/rpg/xp', AUTH, { source: 'hack_xp_1000' })
    expect(r.status).toBe(400)
  })

  it('returns 400 when source is missing', async () => {
    const r = await call('POST', '/api/rpg/xp', AUTH, {})
    expect(r.status).toBe(400)
  })

  it('awards correct XP for workout_checkin', async () => {
    const r = await call('POST', '/api/rpg/xp', AUTH, { source: 'workout_checkin' })
    expect(r.status).toBe(201)
    const b = r.body as { ok: boolean; earned: number; totalXp: number; level: number }
    expect(b.ok).toBe(true)
    expect(b.earned).toBe(50)
    expect(b.totalXp).toBe(50)
    expect(b.level).toBe(1)
  })

  it('awards correct XP for kanban_done (25 XP)', async () => {
    const r = await call('POST', '/api/rpg/xp', AUTH, { source: 'kanban_done' })
    expect(r.status).toBe(201)
    expect((r.body as { earned: number }).earned).toBe(25)
  })

  it('accumulates XP and bumps level on threshold', async () => {
    // 4 × kanban_done = 100 XP → level 2
    for (let i = 0; i < 4; i++) {
      await call('POST', '/api/rpg/xp', AUTH, { source: 'kanban_done' })
    }
    const r = await call('GET', '/api/rpg/stats')
    const b = r.body as { totalXp: number; level: number }
    expect(b.totalXp).toBe(100)
    expect(b.level).toBe(2)
  })

  it('stores optional description without error', async () => {
    const r = await call('POST', '/api/rpg/xp', AUTH, { source: 'daily_log', description: 'Evening entry' })
    expect(r.status).toBe(201)
  })
})

// ---------------------------------------------------------------------------
// 6. GET /api/rpg/stats
// ---------------------------------------------------------------------------

describe('GET /api/rpg/stats', () => {
  beforeEach(() => { __setDbSeam(makeInMemoryDb()) })

  it('returns 403 without auth', async () => {
    const r = await call('GET', '/api/rpg/stats', ANON)
    expect(r.status).toBe(403)
  })

  it('returns zero stats on fresh DB', async () => {
    const r = await call('GET', '/api/rpg/stats')
    expect(r.status).toBe(200)
    const b = r.body as { totalXp: number; level: number; streak: number; combo: number }
    expect(b.totalXp).toBe(0)
    expect(b.level).toBe(1)
    expect(b.streak).toBe(0)
    expect(b.combo).toBe(0)
  })

  it('returns today as YYYY-MM-DD string', async () => {
    const r = await call('GET', '/api/rpg/stats')
    const b = r.body as { today: string }
    expect(b.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('includes xpInLevel and xpForNextLevel', async () => {
    const r = await call('GET', '/api/rpg/stats')
    const b = r.body as { xpInLevel: number; xpForNextLevel: number }
    expect(typeof b.xpInLevel).toBe('number')
    expect(typeof b.xpForNextLevel).toBe('number')
  })

  it('includes recentAchievements array', async () => {
    const r = await call('GET', '/api/rpg/stats')
    expect(Array.isArray((r.body as { recentAchievements: unknown[] }).recentAchievements)).toBe(true)
  })

  it('combo increments with today events', async () => {
    for (let i = 0; i < 2; i++) {
      await call('POST', '/api/rpg/xp', AUTH, { source: 'heartbeat' })
    }
    const r = await call('GET', '/api/rpg/stats')
    expect((r.body as { combo: number }).combo).toBe(2)
  })
})
