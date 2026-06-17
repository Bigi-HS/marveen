import Database from 'better-sqlite3'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { importMatchesQuery } from './codetree-extract.js'

export const CODETREE_DB_FILENAME = 'codetree.db'
export const CODETREE_SCHEMA_VERSION = '1'

export interface SymbolRow {
  name: string
  kind: string
  file: string
  line: number
  exported: boolean
}

export interface ImportRow {
  from_file: string
  to_module: string
  imported_names: string[] | null
}

export interface ImporterRow {
  from_file: string
  imported_names: string[] | null
}

export interface IndexMeta {
  indexed_at: number // epoch seconds
  files_count: number
  symbols_count: number
  imports_count: number
  schema_version: string
}

let codetreeDb: Database.Database | undefined

// Codetree lives in a SEPARATE SQLite file from claudeclaw.db: it is a fully
// rebuilable derived artifact, so coupling it to the live fleet DB risks WAL
// contention during a rebuild + schema coupling. Same pragmas as the main DB
// so the read-side (HTTP server) and write-side (rebuild child process) share
// the file safely under WAL.
export function initCodetreeDatabase(dbPathOverride?: string): void {
  if (codetreeDb) {
    try { codetreeDb.close() } catch { /* already closed */ }
  }
  const dbPath = dbPathOverride ?? join(STORE_DIR, CODETREE_DB_FILENAME)
  codetreeDb = new Database(dbPath)
  codetreeDb.pragma('journal_mode = WAL')
  codetreeDb.pragma('busy_timeout = 5000')
  codetreeDb.pragma('synchronous = NORMAL')

  codetreeDb.exec(`
    CREATE TABLE IF NOT EXISTS code_symbols (
      id       INTEGER PRIMARY KEY,
      name     TEXT NOT NULL,
      kind     TEXT NOT NULL,
      file     TEXT NOT NULL,
      line     INTEGER NOT NULL,
      exported INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON code_symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON code_symbols(file);

    CREATE TABLE IF NOT EXISTS code_imports (
      id             INTEGER PRIMARY KEY,
      from_file      TEXT NOT NULL,
      to_module      TEXT NOT NULL,
      imported_names TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_imports_from ON code_imports(from_file);
    CREATE INDEX IF NOT EXISTS idx_imports_to   ON code_imports(to_module);

    CREATE TABLE IF NOT EXISTS code_index_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

export function getCodetreeDb(): Database.Database {
  if (!codetreeDb) throw new Error('codetree DB not initialized')
  return codetreeDb
}

function readMetaValue(key: string): string | undefined {
  const row = getCodetreeDb().prepare('SELECT value FROM code_index_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function getIndexedAtEpoch(): number | null {
  const v = readMetaValue('indexed_at')
  return v != null ? Number(v) : null
}

// "Built" = a rebuild has run at least once (indexed_at present). The GET
// endpoints use this to return 503 before any rebuild rather than a misleading
// empty result (CT-AC4 / CT-SEC1 staleness theme).
export function isCodetreeBuilt(): boolean {
  return getIndexedAtEpoch() != null
}

export function getIndexMeta(): IndexMeta | null {
  const indexed_at = getIndexedAtEpoch()
  if (indexed_at == null) return null
  return {
    indexed_at,
    files_count: Number(readMetaValue('files_count') ?? 0),
    symbols_count: Number(readMetaValue('symbols_count') ?? 0),
    imports_count: Number(readMetaValue('imports_count') ?? 0),
    schema_version: readMetaValue('schema_version') ?? CODETREE_SCHEMA_VERSION,
  }
}

export function querySymbolsByName(name: string): SymbolRow[] {
  const rows = getCodetreeDb()
    .prepare('SELECT name, kind, file, line, exported FROM code_symbols WHERE name = ? ORDER BY file, line')
    .all(name) as Array<{ name: string; kind: string; file: string; line: number; exported: number }>
  return rows.map((r) => ({ ...r, exported: r.exported === 1 }))
}

export function fileIndexed(file: string): boolean {
  const row = getCodetreeDb().prepare('SELECT 1 FROM code_symbols WHERE file = ? LIMIT 1').get(file)
  return row != null
}

// Every indexed symbol. Used by the impact motor's keyword substring match
// (~2k rows -- a full scan filtered in JS is negligible and keeps the match
// semantics in one place: codetree-impact.selectSymbolHits).
export function queryAllSymbols(): SymbolRow[] {
  const rows = getCodetreeDb()
    .prepare('SELECT name, kind, file, line, exported FROM code_symbols ORDER BY file, line')
    .all() as Array<{ name: string; kind: string; file: string; line: number; exported: number }>
  return rows.map((r) => ({ ...r, exported: r.exported === 1 }))
}

export function queryExportsForFile(file: string): Array<{ name: string; kind: string; line: number }> {
  return getCodetreeDb()
    .prepare('SELECT name, kind, line FROM code_symbols WHERE file = ? AND exported = 1 ORDER BY line')
    .all(file) as Array<{ name: string; kind: string; line: number }>
}

// Importers are resolved at query time: each stored import keeps its raw
// to_module, and the match is computed against the importing file's path so
// both './db' and 'src/db.ts' query forms resolve to the same edge (CT-AC3).
// ~hundreds of rows, so a full scan is negligible. Deduped by from_file.
export function queryImporters(moduleQuery: string): ImporterRow[] {
  const rows = getCodetreeDb()
    .prepare('SELECT from_file, to_module, imported_names FROM code_imports ORDER BY from_file')
    .all() as Array<{ from_file: string; to_module: string; imported_names: string | null }>
  const seen = new Set<string>()
  const out: ImporterRow[] = []
  for (const r of rows) {
    if (!importMatchesQuery(r.from_file, r.to_module, moduleQuery)) continue
    if (seen.has(r.from_file)) continue
    seen.add(r.from_file)
    out.push({
      from_file: r.from_file,
      imported_names: r.imported_names != null ? (JSON.parse(r.imported_names) as string[]) : null,
    })
  }
  return out
}

// Full replace of the index data in a single transaction (idempotent rebuild).
// CREATE-IF-NOT-EXISTS keeps the schema stable for concurrent readers; we
// truncate-then-insert rather than DROP so the server's read connection never
// sees a missing table mid-rebuild.
export function replaceIndexData(symbols: SymbolRow[], imports: ImportRow[]): void {
  const db = getCodetreeDb()
  const insSymbol = db.prepare(
    'INSERT INTO code_symbols (name, kind, file, line, exported) VALUES (?, ?, ?, ?, ?)',
  )
  const insImport = db.prepare(
    'INSERT INTO code_imports (from_file, to_module, imported_names) VALUES (?, ?, ?)',
  )
  const tx = db.transaction(() => {
    db.exec('DELETE FROM code_symbols; DELETE FROM code_imports;')
    for (const s of symbols) insSymbol.run(s.name, s.kind, s.file, s.line, s.exported ? 1 : 0)
    for (const i of imports) {
      insImport.run(i.from_file, i.to_module, i.imported_names != null ? JSON.stringify(i.imported_names) : null)
    }
  })
  tx()
}

export function setIndexMeta(meta: Omit<IndexMeta, 'schema_version'> & { schema_version?: string }): void {
  const db = getCodetreeDb()
  const upsert = db.prepare(
    'INSERT INTO code_index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
  const tx = db.transaction(() => {
    upsert.run('indexed_at', String(meta.indexed_at))
    upsert.run('files_count', String(meta.files_count))
    upsert.run('symbols_count', String(meta.symbols_count))
    upsert.run('imports_count', String(meta.imports_count))
    upsert.run('schema_version', meta.schema_version ?? CODETREE_SCHEMA_VERSION)
  })
  tx()
  logger.debug({ indexed_at: meta.indexed_at, files: meta.files_count }, 'codetree index meta updated')
}
