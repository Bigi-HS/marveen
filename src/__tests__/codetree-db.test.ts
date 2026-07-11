import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { rmSync } from 'node:fs'
import {
  initCodetreeDatabase,
  isCodetreeBuilt,
  getIndexMeta,
  getIndexedAtEpoch,
  querySymbolsByName,
  fileIndexed,
  queryExportsForFile,
  queryImporters,
  queryCallers,
  queryCallees,
  queryExportedSymbols,
  queryDistinctCalleeNames,
  queryAllImportEdges,
  replaceIndexData,
  setIndexMeta,
  CODETREE_SCHEMA_VERSION,
} from '../web/codetree-db.js'

const TEST_DB = '/tmp/test-codetree-db.db'

function seed() {
  replaceIndexData(
    [
      { name: 'saveAgentMemory', kind: 'function', file: 'src/db.ts', line: 826, exported: true },
      { name: 'getAgentMemories', kind: 'function', file: 'src/db.ts', line: 810, exported: true },
      { name: 'internalHelper', kind: 'function', file: 'src/db.ts', line: 5, exported: false },
      { name: 'startWebServer', kind: 'function', file: 'src/web.ts', line: 71, exported: true },
    ],
    [
      { from_file: 'src/server.ts', to_module: './db.js', imported_names: ['saveAgentMemory', 'getAgentMemories'] },
      { from_file: 'src/memory.ts', to_module: '../db.js', imported_names: null },
      { from_file: 'src/db.ts', to_module: 'better-sqlite3', imported_names: null },
    ],
    [
      { caller_file: 'src/server.ts', caller_symbol: 'startWebServer', callee_name: 'saveAgentMemory', line: 90 },
      { caller_file: 'src/server.ts', caller_symbol: 'startWebServer', callee_name: 'saveAgentMemory', line: 95 },
      { caller_file: 'src/memory.ts', caller_symbol: 'flush', callee_name: 'saveAgentMemory', line: 12 },
      { caller_file: 'src/db.ts', caller_symbol: 'saveAgentMemory', callee_name: 'internalHelper', line: 830 },
      { caller_file: 'src/db.ts', caller_symbol: null, callee_name: 'startWebServer', line: 900 },
    ],
  )
  setIndexMeta({ indexed_at: 1_700_000_000, files_count: 3, symbols_count: 4, imports_count: 3, calls_count: 5 })
}

describe('codetree-db', () => {
  beforeEach(() => {
    rmSync(TEST_DB, { force: true })
    rmSync(TEST_DB + '-wal', { force: true })
    rmSync(TEST_DB + '-shm', { force: true })
    initCodetreeDatabase(TEST_DB)
  })
  afterAll(() => {
    rmSync(TEST_DB, { force: true })
    rmSync(TEST_DB + '-wal', { force: true })
    rmSync(TEST_DB + '-shm', { force: true })
  })

  it('reports not-built before any meta is written (CT-AC4)', () => {
    expect(isCodetreeBuilt()).toBe(false)
    expect(getIndexedAtEpoch()).toBeNull()
    expect(getIndexMeta()).toBeNull()
  })

  it('reports built after meta is set', () => {
    seed()
    expect(isCodetreeBuilt()).toBe(true)
    expect(getIndexedAtEpoch()).toBe(1_700_000_000)
  })

  it('getIndexMeta returns counts + schema_version', () => {
    seed()
    const meta = getIndexMeta()!
    expect(meta.files_count).toBe(3)
    expect(meta.symbols_count).toBe(4)
    expect(meta.imports_count).toBe(3)
    expect(meta.calls_count).toBe(5)
    expect(meta.schema_version).toBe(CODETREE_SCHEMA_VERSION)
  })

  it('querySymbolsByName is an exact, case-sensitive match (CT-AC1)', () => {
    seed()
    const rows = querySymbolsByName('saveAgentMemory')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'saveAgentMemory', file: 'src/db.ts', line: 826, exported: true })
    expect(querySymbolsByName('saveagentmemory')).toHaveLength(0)
    expect(querySymbolsByName('doesNotExist')).toEqual([])
  })

  it('fileIndexed distinguishes indexed vs unknown files (CT-AC2)', () => {
    seed()
    expect(fileIndexed('src/db.ts')).toBe(true)
    expect(fileIndexed('src/never-seen.ts')).toBe(false)
  })

  it('queryExportsForFile returns only exported symbols (CT-AC2)', () => {
    seed()
    const exports = queryExportsForFile('src/db.ts')
    const names = exports.map((e) => e.name)
    expect(names).toContain('saveAgentMemory')
    expect(names).toContain('getAgentMemories')
    expect(names).not.toContain('internalHelper')
  })

  it('queryImporters matches both relative and repo-relative query forms identically (CT-AC3)', () => {
    seed()
    const repoForm = queryImporters('src/db.ts').map((r) => r.from_file).sort()
    const relForm = queryImporters('./db').map((r) => r.from_file).sort()
    expect(repoForm).toContain('src/server.ts')
    expect(repoForm).toContain('src/memory.ts')
    expect(relForm).toEqual(repoForm)
  })

  it('queryImporters parses imported_names JSON and preserves null', () => {
    seed()
    const rows = queryImporters('src/db.ts')
    const server = rows.find((r) => r.from_file === 'src/server.ts')!
    const memory = rows.find((r) => r.from_file === 'src/memory.ts')!
    expect(server.imported_names).toEqual(['saveAgentMemory', 'getAgentMemories'])
    expect(memory.imported_names).toBeNull()
  })

  it('queryImporters matches a package import by name', () => {
    seed()
    expect(queryImporters('better-sqlite3').map((r) => r.from_file)).toContain('src/db.ts')
  })

  it('queryImporters returns empty for an unimported module', () => {
    seed()
    expect(queryImporters('src/nonexistent.ts')).toEqual([])
  })

  it('replaceIndexData is idempotent (a second rebuild replaces, not appends)', () => {
    seed()
    seed()
    expect(querySymbolsByName('saveAgentMemory')).toHaveLength(1)
    expect(getIndexMeta()!.symbols_count).toBe(4)
    expect(queryCallers('saveAgentMemory')).toHaveLength(3)
  })

  it('queryCallers returns every call site of a callee, ordered by file then line', () => {
    seed()
    const rows = queryCallers('saveAgentMemory')
    expect(rows).toEqual([
      { caller_file: 'src/memory.ts', caller_symbol: 'flush', line: 12 },
      { caller_file: 'src/server.ts', caller_symbol: 'startWebServer', line: 90 },
      { caller_file: 'src/server.ts', caller_symbol: 'startWebServer', line: 95 },
    ])
  })

  it('queryCallers exposes a module-scope caller as a null caller_symbol', () => {
    seed()
    expect(queryCallers('startWebServer')).toEqual([
      { caller_file: 'src/db.ts', caller_symbol: null, line: 900 },
    ])
  })

  it('queryCallers returns empty for an uncalled name', () => {
    seed()
    expect(queryCallers('neverCalled')).toEqual([])
  })

  it('queryCallees returns the distinct names a symbol calls, ordered by name', () => {
    seed()
    expect(queryCallees('startWebServer')).toEqual([{ callee_name: 'saveAgentMemory' }])
  })

  it('queryCallees can scope to a specific caller file', () => {
    seed()
    expect(queryCallees('saveAgentMemory', 'src/db.ts')).toEqual([{ callee_name: 'internalHelper' }])
    expect(queryCallees('saveAgentMemory', 'src/other.ts')).toEqual([])
  })

  it('queryCallees returns empty for a symbol that calls nothing', () => {
    seed()
    expect(queryCallees('internalHelper')).toEqual([])
  })

  it('queryExportedSymbols returns only exported symbols, ordered by file then line', () => {
    seed()
    const rows = queryExportedSymbols()
    expect(rows.map((r) => r.name)).toEqual(['getAgentMemories', 'saveAgentMemory', 'startWebServer'])
    expect(rows.every((r) => r.exported === true)).toBe(true)
    expect(rows.map((r) => r.name)).not.toContain('internalHelper')
  })

  it('queryDistinctCalleeNames returns the deduped set of call targets', () => {
    seed()
    const names = queryDistinctCalleeNames()
    expect(names).toBeInstanceOf(Set)
    expect([...names].sort()).toEqual(['internalHelper', 'saveAgentMemory', 'startWebServer'])
  })

  it('queryAllImportEdges returns every edge with imported_names parsed', () => {
    seed()
    const edges = queryAllImportEdges()
    expect(edges).toHaveLength(3)
    const server = edges.find((e) => e.from_file === 'src/server.ts')!
    expect(server.imported_names).toEqual(['saveAgentMemory', 'getAgentMemories'])
    const memory = edges.find((e) => e.from_file === 'src/memory.ts')!
    expect(memory.imported_names).toBeNull()
  })
})
