import Database from 'better-sqlite3'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { importMatchesQuery } from './codetree-extract.js'

export const CODETREE_DB_FILENAME = 'codetree.db'
// v2 adds the code_calls table (Phase-2 call-path tracing, card 52815f7c).
export const CODETREE_SCHEMA_VERSION = '2'

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

// A call/new edge: `caller_symbol` in `caller_file` invokes `callee_name`.
// caller_symbol is null for module-scope calls. callee_name is name-based
// (resolved at query time), matching the import-edge model.
export interface CallRow {
  caller_file: string
  caller_symbol: string | null
  callee_name: string
  line: number
}

export interface CallerRow {
  caller_file: string
  caller_symbol: string | null
  line: number
}

export interface IndexMeta {
  indexed_at: number // epoch seconds
  files_count: number
  symbols_count: number
  imports_count: number
  calls_count: number
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

    CREATE TABLE IF NOT EXISTS code_calls (
      id            INTEGER PRIMARY KEY,
      caller_file   TEXT NOT NULL,
      caller_symbol TEXT,
      callee_name   TEXT NOT NULL,
      line          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calls_callee ON code_calls(callee_name);
    CREATE INDEX IF NOT EXISTS idx_calls_caller ON code_calls(caller_symbol);

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

// The schema_version stored in the index, or undefined if never written. A
// stored value that differs from CODETREE_SCHEMA_VERSION means the on-disk index
// predates the current shape (e.g. a v1 index has no code_calls data) and must
// be treated as stale so consumers rebuild rather than read a silently-empty
// graph (card 52815f7c).
export function getStoredSchemaVersion(): string | undefined {
  return readMetaValue('schema_version')
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
    calls_count: Number(readMetaValue('calls_count') ?? 0),
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

// "Who calls X": every call site whose callee_name matches, ordered by file then
// line. Name-based (a callee_name is the rightmost identifier of the call target),
// so cross-file callers resolve without module resolution -- the consumer
// disambiguates same-named callees by caller_file, as with import edges. Indexed
// on callee_name.
export function queryCallers(name: string): CallerRow[] {
  return getCodetreeDb()
    .prepare(
      'SELECT caller_file, caller_symbol, line FROM code_calls WHERE callee_name = ? ORDER BY caller_file, line',
    )
    .all(name) as CallerRow[]
}

// "What does X call": the distinct callee names invoked by symbol X, ordered by
// name. Optional `file` scopes to a single caller file when the same symbol name
// is defined in more than one file. Indexed on caller_symbol.
export function queryCallees(symbol: string, file?: string): Array<{ callee_name: string }> {
  const sql =
    'SELECT DISTINCT callee_name FROM code_calls WHERE caller_symbol = ?' +
    (file != null ? ' AND caller_file = ?' : '') +
    ' ORDER BY callee_name'
  const stmt = getCodetreeDb().prepare(sql)
  const rows = file != null ? stmt.all(symbol, file) : stmt.all(symbol)
  return rows as Array<{ callee_name: string }>
}

// Full replace of the index data in a single transaction (idempotent rebuild).
// CREATE-IF-NOT-EXISTS keeps the schema stable for concurrent readers; we
// truncate-then-insert rather than DROP so the server's read connection never
// sees a missing table mid-rebuild.
export function replaceIndexData(symbols: SymbolRow[], imports: ImportRow[], calls: CallRow[] = []): void {
  const db = getCodetreeDb()
  const insSymbol = db.prepare(
    'INSERT INTO code_symbols (name, kind, file, line, exported) VALUES (?, ?, ?, ?, ?)',
  )
  const insImport = db.prepare(
    'INSERT INTO code_imports (from_file, to_module, imported_names) VALUES (?, ?, ?)',
  )
  const insCall = db.prepare(
    'INSERT INTO code_calls (caller_file, caller_symbol, callee_name, line) VALUES (?, ?, ?, ?)',
  )
  const tx = db.transaction(() => {
    db.exec('DELETE FROM code_symbols; DELETE FROM code_imports; DELETE FROM code_calls;')
    for (const s of symbols) insSymbol.run(s.name, s.kind, s.file, s.line, s.exported ? 1 : 0)
    for (const i of imports) {
      insImport.run(i.from_file, i.to_module, i.imported_names != null ? JSON.stringify(i.imported_names) : null)
    }
    for (const c of calls) insCall.run(c.caller_file, c.caller_symbol, c.callee_name, c.line)
  })
  tx()
}

export function setIndexMeta(
  meta: Omit<IndexMeta, 'schema_version' | 'calls_count'> & { calls_count?: number; schema_version?: string },
): void {
  const db = getCodetreeDb()
  const upsert = db.prepare(
    'INSERT INTO code_index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
  const tx = db.transaction(() => {
    upsert.run('indexed_at', String(meta.indexed_at))
    upsert.run('files_count', String(meta.files_count))
    upsert.run('symbols_count', String(meta.symbols_count))
    upsert.run('imports_count', String(meta.imports_count))
    upsert.run('calls_count', String(meta.calls_count ?? 0))
    upsert.run('schema_version', meta.schema_version ?? CODETREE_SCHEMA_VERSION)
  })
  tx()
  logger.debug({ indexed_at: meta.indexed_at, files: meta.files_count }, 'codetree index meta updated')
}
