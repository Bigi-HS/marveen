// Journal endpoints (Phase 0C, card 48bf3fcf)
//
// GET  /api/journal/entries[?limit=N]  -- latest N entries (default 20)
// POST /api/journal/entries            -- create a new entry
//
// Stores entries in journal_entries (noa.db). Auth: any authenticated identity.

import Database from 'better-sqlite3'
import { readBody, json } from '../http-helpers.js'
import { getNoaDb } from '../../noa-db.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

// ---------------------------------------------------------------------------
// DB seam
// ---------------------------------------------------------------------------

let _dbSeam: Database.Database | null = null
export function __setDbSeam(db: Database.Database | null): void { _dbSeam = db }
function getDb(): Database.Database { return _dbSeam ?? getNoaDb() }

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

export function applyJournalMigrations(db: Database.Database = getNoaDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      content    TEXT NOT NULL,
      mood       TEXT,
      tags       TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `)
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function tryHandleJournal(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url, identity } = ctx

  if (!path.startsWith('/api/journal/')) return false

  if (path === '/api/journal/entries') {
    if (!identity?.agentId) {
      json(res, { error: 'authentication required' }, 403)
      return true
    }

    if (method === 'GET') {
      const limitParam = url.searchParams.get('limit')
      const limit = Math.min(Math.max(1, parseInt(limitParam ?? '20', 10) || 20), 100)
      const rows = getDb()
        .prepare('SELECT id, content, mood, tags, created_at FROM journal_entries ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(limit) as Array<{ id: number; content: string; mood: string | null; tags: string | null; created_at: number }>
      json(res, { entries: rows.map(r => ({ id: r.id, content: r.content, mood: r.mood, tags: r.tags, createdAt: r.created_at })) })
      return true
    }

    if (method === 'POST') {
      const raw = await readBody(req, { maxBytes: 32 * 1024 })
      let parsed: { content?: unknown; mood?: unknown; tags?: unknown }
      try {
        parsed = JSON.parse(raw.toString())
      } catch {
        json(res, { error: 'invalid JSON' }, 400)
        return true
      }
      if (!parsed.content || typeof parsed.content !== 'string' || !parsed.content.trim()) {
        json(res, { error: 'content is required' }, 400)
        return true
      }
      const mood = typeof parsed.mood === 'string' ? parsed.mood.slice(0, 64) : null
      const tags = typeof parsed.tags === 'string' ? parsed.tags.slice(0, 256) : null
      try {
        const result = getDb()
          .prepare('INSERT INTO journal_entries (content, mood, tags) VALUES (?, ?, ?)')
          .run(parsed.content.trim(), mood, tags)
        json(res, { ok: true, id: result.lastInsertRowid }, 201)
      } catch (err) {
        logger.error({ err }, 'journal: db error')
        json(res, { error: 'internal error' }, 500)
      }
      return true
    }
  }

  return false
}
