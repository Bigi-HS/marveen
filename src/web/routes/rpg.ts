// RPG backend (card 71d8c9ba, Phase 3C).
//
// GET  /api/rpg/stats  -- XP total, level, streak, combo, recent achievements
// POST /api/rpg/xp     -- award XP for a whitelisted source (server-side amounts)
//
// Streak logic: consecutive calendar days (Europe/Budapest) with at least one XP event.
// A streak ending on today OR yesterday is still considered active.
//
// Level formula: level n starts at 50*n*(n-1) cumulative XP.
//   L1=0, L2=100, L3=300, L4=600, L5=1000, ...
//   solved: level = floor((50 + sqrt(2500 + 200*totalXp)) / 100)

import { json, readBody } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { getNoaDb } from '../../noa-db.js'
import Database from 'better-sqlite3'
import type { RouteContext } from './types.js'

// ---------------------------------------------------------------------------
// XP source whitelist (server-side amounts -- clients cannot choose amounts)
// ---------------------------------------------------------------------------

export const RPG_XP_SOURCES: Record<string, { amount: number; label: string }> = {
  workout_checkin: { amount: 50,  label: 'Edzés teljesítve' },
  kanban_done:     { amount: 25,  label: 'Feladat kész' },
  daily_log:       { amount: 15,  label: 'Napi napló' },
  streak_bonus:    { amount: 100, label: 'Streak bónusz' },
  heartbeat:       { amount: 10,  label: 'Heartbeat' },
  coding_session:  { amount: 30,  label: 'Kódolás' },
  goal_milestone:  { amount: 75,  label: 'Mérföldkő' },
}

// ---------------------------------------------------------------------------
// Level math
// ---------------------------------------------------------------------------

export interface LevelInfo {
  level: number
  xpInLevel: number
  xpForNextLevel: number
}

export function computeLevel(totalXp: number): LevelInfo {
  // Level n starts at 50*n*(n-1) XP.
  // Solving 50*n^2 - 50*n - totalXp = 0 gives: n = (50 + sqrt(2500 + 200*totalXp)) / 100
  const level = Math.floor((50 + Math.sqrt(2500 + 200 * totalXp)) / 100)
  const requiredForLevel = 50 * level * (level - 1)
  const xpForNextLevel = 100 * level   // step size from level n to n+1
  return {
    level,
    xpInLevel: totalXp - requiredForLevel,
    xpForNextLevel,
  }
}

// ---------------------------------------------------------------------------
// Streak calculation
// ---------------------------------------------------------------------------

// Pure function; injectable today string for tests.
// dates: YYYY-MM-DD strings, sorted DESC (most recent first).
// today: YYYY-MM-DD in Europe/Budapest.
export function computeStreak(dates: string[], today: string): number {
  if (dates.length === 0) return 0

  const dateSet = new Set(dates)
  const yesterday = offsetDate(today, -1)

  // Start from today if there's an event today, otherwise from yesterday.
  const anchor = dateSet.has(today) ? today : dateSet.has(yesterday) ? yesterday : null
  if (!anchor) return 0

  let streak = 0
  let cur = anchor
  while (dateSet.has(cur)) {
    streak++
    cur = offsetDate(cur, -1)
  }
  return streak
}

// Subtract |days| days from a YYYY-MM-DD string using UTC arithmetic.
// No DST ambiguity since we only do date arithmetic (not time).
function offsetDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Europe/Budapest date string (DST-safe)
function todayBudapest(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest' }).format(new Date())
}

// ---------------------------------------------------------------------------
// DB interface + seam
// ---------------------------------------------------------------------------

export interface RpgDb {
  insertXpEvent(source: string, amount: number, description: string | null, earnedAt: number, date: string): void
  getTotalXp(): number
  getEventDates(): string[]
  getTodayEventCount(date: string): number
  insertAchievement(id: string, title: string, unlockedAt: number): void
  getAchievements(): Array<{ id: string; title: string; unlocked_at: number }>
  getSourceBreakdown(): Record<string, number>
}

let _dbSeam: RpgDb | null = null
export function __setDbSeam(db: RpgDb | null): void { _dbSeam = db }

class SqliteRpgDb implements RpgDb {
  constructor(private db: Database.Database) {}

  insertXpEvent(source: string, amount: number, description: string | null, earnedAt: number, date: string): void {
    this.db.prepare(
      'INSERT INTO xp_events (source, amount, description, earned_at, date) VALUES (?, ?, ?, ?, ?)',
    ).run(source, amount, description, earnedAt, date)
  }

  getTotalXp(): number {
    return (this.db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM xp_events').get() as { total: number }).total
  }

  getEventDates(): string[] {
    return (this.db.prepare(
      'SELECT DISTINCT date FROM xp_events ORDER BY date DESC LIMIT 400',
    ).all() as { date: string }[]).map((r) => r.date)
  }

  getTodayEventCount(date: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS cnt FROM xp_events WHERE date = ?').get(date) as { cnt: number }).cnt
  }

  insertAchievement(id: string, title: string, unlockedAt: number): void {
    this.db.prepare(
      'INSERT OR IGNORE INTO achievements (id, title, unlocked_at) VALUES (?, ?, ?)',
    ).run(id, title, unlockedAt)
  }

  getAchievements(): Array<{ id: string; title: string; unlocked_at: number }> {
    return this.db.prepare(
      'SELECT id, title, unlocked_at FROM achievements ORDER BY unlocked_at DESC LIMIT 20',
    ).all() as Array<{ id: string; title: string; unlocked_at: number }>
  }

  getSourceBreakdown(): Record<string, number> {
    const rows = this.db.prepare(
      'SELECT source, SUM(amount) AS total FROM xp_events GROUP BY source',
    ).all() as Array<{ source: string; total: number }>
    const result: Record<string, number> = {}
    for (const row of rows) result[row.source] = row.total
    return result
  }
}

function getDb(): RpgDb {
  if (_dbSeam) return _dbSeam
  return new SqliteRpgDb(getNoaDb())
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

export function applyRpgMigrations(db: Database.Database = getNoaDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS xp_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT    NOT NULL,
      amount      INTEGER NOT NULL,
      description TEXT,
      earned_at   INTEGER NOT NULL,
      date        TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_xp_events_date ON xp_events (date);

    CREATE TABLE IF NOT EXISTS achievements (
      id          TEXT    PRIMARY KEY,
      title       TEXT    NOT NULL,
      unlocked_at INTEGER NOT NULL
    );
  `)
}

// ---------------------------------------------------------------------------
// Achievement unlock helper
// ---------------------------------------------------------------------------

function maybeUnlockAchievements(db: RpgDb, totalXp: number, streak: number): void {
  const now = Math.floor(Date.now() / 1000)

  const checks: Array<{ id: string; title: string; condition: boolean }> = [
    { id: 'first-xp',  title: 'Első XP',      condition: totalXp >= 1 },
    { id: 'level-5',   title: '5. szint',      condition: computeLevel(totalXp).level >= 5 },
    { id: 'level-10',  title: '10. szint',     condition: computeLevel(totalXp).level >= 10 },
    { id: 'streak-3',  title: '3 napos streak', condition: streak >= 3 },
    { id: 'streak-7',  title: '7 napos streak', condition: streak >= 7 },
    { id: 'streak-30', title: '30 napos streak', condition: streak >= 30 },
  ]

  for (const { id, title, condition } of checks) {
    if (condition) {
      db.insertAchievement(id, title, now)
    }
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function tryHandleRpg(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, identity } = ctx

  if (!path.startsWith('/api/rpg/')) return false

  if (!identity?.agentId) {
    json(res, { error: 'authentication required' }, 403)
    return true
  }

  // GET /api/rpg/stats
  if (path === '/api/rpg/stats' && method === 'GET') {
    const db = getDb()
    const today = todayBudapest()
    const totalXp = db.getTotalXp()
    const { level, xpInLevel, xpForNextLevel } = computeLevel(totalXp)
    const dates = db.getEventDates()
    const streak = computeStreak(dates, today)
    const combo = db.getTodayEventCount(today)
    const recentAchievements = db.getAchievements()
    const sourceBreakdown = db.getSourceBreakdown()

    json(res, { totalXp, level, xpInLevel, xpForNextLevel, streak, combo, today, recentAchievements, sourceBreakdown })
    return true
  }

  // POST /api/rpg/xp
  if (path === '/api/rpg/xp' && method === 'POST') {
    let body: { source?: string; description?: string }
    try {
      const raw = await readBody(req, { maxBytes: 4 * 1024 })
      body = JSON.parse(raw.toString())
    } catch {
      json(res, { error: 'invalid JSON body' }, 400)
      return true
    }

    const source = body.source
    if (!source || typeof source !== 'string') {
      json(res, { error: 'source is required' }, 400)
      return true
    }

    const sourceDef = RPG_XP_SOURCES[source]
    if (!sourceDef) {
      json(res, { error: `unknown source: ${source}`, allowed: Object.keys(RPG_XP_SOURCES) }, 400)
      return true
    }

    const description = typeof body.description === 'string' ? body.description : null
    const now = Math.floor(Date.now() / 1000)
    const today = todayBudapest()

    const db = getDb()
    db.insertXpEvent(source, sourceDef.amount, description, now, today)

    const totalXp = db.getTotalXp()
    const { level } = computeLevel(totalXp)

    // Check for new achievements after the XP award
    const dates = db.getEventDates()
    const streak = computeStreak(dates, today)
    maybeUnlockAchievements(db, totalXp, streak)

    logger.info({ source, amount: sourceDef.amount, totalXp, level }, 'rpg: XP awarded')
    json(res, { ok: true, earned: sourceDef.amount, totalXp, level }, 201)
    return true
  }

  return false
}
