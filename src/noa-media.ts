import { randomUUID } from 'node:crypto'
import { getNoaDb } from './noa-db.js'

export type MediaType = 'book' | 'game' | 'series' | 'film' | 'anime' | 'other'
export type MediaStatus = 'want' | 'in_progress' | 'completed' | 'dropped'

export interface MediaItem {
  id: string
  agent_id: string
  type: MediaType
  title: string
  author: string | null
  status: MediaStatus
  rating: number | null
  notes: string | null
  shelf: string | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

const VALID_TYPES: ReadonlySet<string> = new Set(['book', 'game', 'series', 'film', 'anime', 'other'])
const VALID_STATUSES: ReadonlySet<string> = new Set(['want', 'in_progress', 'completed', 'dropped'])

export function isMediaType(v: unknown): v is MediaType {
  return typeof v === 'string' && VALID_TYPES.has(v)
}

export function isMediaStatus(v: unknown): v is MediaStatus {
  return typeof v === 'string' && VALID_STATUSES.has(v)
}

export function applyMediaMigrations(): void {
  const db = getNoaDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL DEFAULT 'gelim',
      type TEXT NOT NULL CHECK(type IN ('book','game','series','film','anime','other')),
      title TEXT NOT NULL,
      author TEXT,
      status TEXT NOT NULL DEFAULT 'want' CHECK(status IN ('want','in_progress','completed','dropped')),
      rating INTEGER CHECK(rating IS NULL OR (rating >= 1 AND rating <= 5)),
      notes TEXT,
      shelf TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_type ON media_items(type)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_status ON media_items(status)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_media_agent ON media_items(agent_id)`)
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000)
}

export function listMediaItems(opts: {
  type?: MediaType
  status?: MediaStatus
  shelf?: string
  q?: string
  limit?: number
  offset?: number
} = {}): MediaItem[] {
  const db = getNoaDb()
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (opts.type) { conditions.push('type = ?'); params.push(opts.type) }
  if (opts.status) { conditions.push('status = ?'); params.push(opts.status) }
  if (opts.shelf) { conditions.push('shelf = ?'); params.push(opts.shelf) }
  if (opts.q) {
    conditions.push('(title LIKE ? OR author LIKE ? OR notes LIKE ?)')
    const like = `%${opts.q}%`
    params.push(like, like, like)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts.limit ?? 100
  const offset = opts.offset ?? 0

  return db.prepare(
    `SELECT * FROM media_items ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as MediaItem[]
}

export function getMediaItem(id: string): MediaItem | undefined {
  return getNoaDb().prepare('SELECT * FROM media_items WHERE id = ?').get(id) as MediaItem | undefined
}

export function createMediaItem(data: {
  agent_id?: string
  type: MediaType
  title: string
  author?: string | null
  status?: MediaStatus
  rating?: number | null
  notes?: string | null
  shelf?: string | null
}): string {
  const db = getNoaDb()
  const id = randomUUID().slice(0, 8)
  const now = nowEpoch()
  db.prepare(`
    INSERT INTO media_items (id, agent_id, type, title, author, status, rating, notes, shelf, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.agent_id ?? 'gelim',
    data.type,
    data.title.trim(),
    data.author ?? null,
    data.status ?? 'want',
    data.rating ?? null,
    data.notes ?? null,
    data.shelf ?? null,
    now,
    now,
  )
  return id
}

export function updateMediaItem(id: string, data: {
  type?: MediaType
  title?: string
  author?: string | null
  status?: MediaStatus
  rating?: number | null
  notes?: string | null
  shelf?: string | null
}): boolean {
  const db = getNoaDb()
  const existing = getMediaItem(id)
  if (!existing) return false

  const now = nowEpoch()
  const completedAt = data.status === 'completed' && existing.status !== 'completed'
    ? now
    : data.status !== undefined && data.status !== 'completed'
      ? null
      : existing.completed_at

  db.prepare(`
    UPDATE media_items SET
      type = ?, title = ?, author = ?, status = ?, rating = ?, notes = ?, shelf = ?,
      updated_at = ?, completed_at = ?
    WHERE id = ?
  `).run(
    data.type ?? existing.type,
    data.title != null ? data.title.trim() : existing.title,
    'author' in data ? data.author : existing.author,
    data.status ?? existing.status,
    'rating' in data ? data.rating : existing.rating,
    'notes' in data ? data.notes : existing.notes,
    'shelf' in data ? data.shelf : existing.shelf,
    now,
    completedAt,
    id,
  )
  return true
}

export function deleteMediaItem(id: string): boolean {
  const result = getNoaDb().prepare('DELETE FROM media_items WHERE id = ?').run(id)
  return result.changes > 0
}

export function listShelves(): string[] {
  const rows = getNoaDb().prepare(
    `SELECT DISTINCT shelf FROM media_items WHERE shelf IS NOT NULL ORDER BY shelf`
  ).all() as { shelf: string }[]
  return rows.map(r => r.shelf)
}
