/**
 * GET  /api/research-search?q=KEYWORD  -- FTS5 full-text search over store/ research docs
 * POST /api/research-search/rebuild    -- rebuild the FTS5 index from store/ files
 *
 * Card a02dcdef (MEM-012). Indexes store/research-*.md + store/obsidian-*.md.
 * Each document is stored as one row: filename (unindexed) + content (indexed).
 * Bearer auth required (standard).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import type Database from 'better-sqlite3'
import { getNoaDb } from '../../noa-db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const STORE_DIR = join(process.env.MARVEEN_ROOT ?? process.cwd(), 'store')

const MIGRATIONS: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS research_fts USING fts5(
     filename UNINDEXED,
     content,
     tokenize = 'unicode61'
   )`,
]

export function applyResearchFtsMigrations(db: Database.Database = getNoaDb()): void {
  for (const stmt of MIGRATIONS) {
    try { db.exec(stmt) } catch { /* already exists */ }
  }
}

/** Rebuild the research_fts index by scanning store/ for research/obsidian docs. */
export function rebuildResearchIndex(
  storeDir: string = STORE_DIR,
  db: Database.Database = getNoaDb(),
): { indexed: number } {
  applyResearchFtsMigrations(db)

  const files: string[] = []
  try {
    const entries = readdirSync(storeDir)
    for (const f of entries) {
      if (
        (f.startsWith('research-') || f.startsWith('obsidian-')) &&
        f.endsWith('.md')
      ) {
        files.push(join(storeDir, f))
      }
    }
  } catch {
    // store/ unreadable -- return empty rather than crash (headless test env)
    return { indexed: 0 }
  }

  db.prepare('DELETE FROM research_fts').run()
  const ins = db.prepare('INSERT INTO research_fts (filename, content) VALUES (?, ?)')
  const insertMany = db.transaction((rows: Array<[string, string]>) => {
    for (const [filename, content] of rows) ins.run(filename, content)
  })

  const rows: Array<[string, string]> = []
  for (const fullPath of files) {
    try {
      const content = readFileSync(fullPath, 'utf-8')
      rows.push([basename(fullPath), content])
    } catch { /* unreadable -- skip */ }
  }
  insertMany(rows)
  return { indexed: rows.length }
}

export interface ResearchSearchResult {
  filename: string
  snippet: string
}

/**
 * FTS5 search over research docs. Returns up to `limit` matches with a
 * highlight snippet around the matched terms. Safe FTS5 query: wraps the
 * query in double-quotes if no operators are present to avoid parse errors.
 */
export function searchResearchDocs(
  query: string,
  limit = 10,
  db: Database.Database = getNoaDb(),
): ResearchSearchResult[] {
  if (!query.trim()) return []
  applyResearchFtsMigrations(db)

  // Wrap bare queries in quotes to avoid FTS5 parse errors on punctuation.
  const hasOperator = /\b(?:AND|OR|NOT)\b|[*"()]/.test(query)
  const safeQuery = hasOperator ? query : `"${query.replace(/"/g, ' ')}"`

  try {
    const rows = db.prepare(
      `SELECT filename, snippet(research_fts, 1, '<b>', '</b>', '...', 32) AS snippet
         FROM research_fts
        WHERE research_fts MATCH ?
        ORDER BY rank
        LIMIT ?`
    ).all(safeQuery, Math.max(1, Math.min(50, limit))) as Array<{ filename: string; snippet: string }>
    return rows
  } catch {
    // Malformed query -- return empty rather than 500
    return []
  }
}

export async function tryHandleResearchSearch(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/research-search' && method === 'GET') {
    const q = ctx.url.searchParams.get('q') ?? ''
    const limitStr = ctx.url.searchParams.get('limit') ?? '10'
    const limit = Math.max(1, Math.min(50, parseInt(limitStr, 10) || 10))
    const results = searchResearchDocs(q, limit)
    json(res, { q, results, count: results.length })
    return true
  }

  if (path === '/api/research-search/rebuild' && method === 'POST') {
    const result = rebuildResearchIndex()
    json(res, { ok: true, indexed: result.indexed })
    return true
  }

  return false
}
