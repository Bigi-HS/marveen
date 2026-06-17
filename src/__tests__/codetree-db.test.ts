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
  )
  setIndexMeta({ indexed_at: 1_700_000_000, files_count: 3, symbols_count: 4, imports_count: 3 })
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
  })
})
