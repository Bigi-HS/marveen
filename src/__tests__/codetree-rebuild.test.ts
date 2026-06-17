import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initCodetreeDatabase, querySymbolsByName, queryImporters, queryExportsForFile, getIndexMeta } from '../web/codetree-db.js'
import { enumerateSourceFiles, rebuildIndex } from '../web/codetree-rebuild.js'

const TEST_DB = '/tmp/test-codetree-rebuild.db'
let root: string

function cleanDb() {
  for (const suffix of ['', '-wal', '-shm']) rmSync(TEST_DB + suffix, { force: true })
}

beforeEach(() => {
  cleanDb()
  initCodetreeDatabase(TEST_DB)
  root = mkdtempSync(join(tmpdir(), 'codetree-fixture-'))
  mkdirSync(join(root, 'src', 'web'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'db.ts'),
    'export function saveAgentMemory() {}\nexport const TABLE = "mem"\nfunction internal() {}\n',
  )
  writeFileSync(
    join(root, 'src', 'server.ts'),
    "import { saveAgentMemory } from './db.js'\nexport function startServer() { saveAgentMemory() }\n",
  )
  writeFileSync(
    join(root, 'src', 'web', 'util.ts'),
    "import { TABLE } from '../db.js'\nexport class Helper {}\n",
  )
  writeFileSync(join(root, 'src', 'db.test.ts'), 'export const SHOULD_NOT_INDEX = 1\n')
  writeFileSync(join(root, 'src', 'types.d.ts'), 'export type Ambient = string\n')
  writeFileSync(join(root, 'scripts', 'tool.ts'), "import { startServer } from '../src/server.js'\nexport function runTool() {}\n")
})

afterAll(() => {
  cleanDb()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('enumerateSourceFiles', () => {
  it('includes src and scripts .ts, excludes tests and .d.ts', () => {
    const files = enumerateSourceFiles(root, ['src', 'scripts']).map((f) => f.replace(root + '/', ''))
    expect(files).toContain('src/db.ts')
    expect(files).toContain('src/server.ts')
    expect(files).toContain('src/web/util.ts')
    expect(files).toContain('scripts/tool.ts')
    expect(files).not.toContain('src/db.test.ts')
    expect(files).not.toContain('src/types.d.ts')
  })
})

describe('rebuildIndex', () => {
  it('indexes symbols and returns an accurate summary', () => {
    const summary = rebuildIndex({ rootDir: root, scanDirs: ['src', 'scripts'] })
    expect(summary.files_indexed).toBe(4) // db, server, web/util, scripts/tool
    expect(summary.symbols_indexed).toBeGreaterThanOrEqual(5)
    expect(summary.files_skipped).toEqual([])
    expect(summary.indexed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(summary.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('makes an exported symbol queryable at its repo-relative path (CT-AC1)', () => {
    rebuildIndex({ rootDir: root, scanDirs: ['src', 'scripts'] })
    const rows = querySymbolsByName('saveAgentMemory')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ file: 'src/db.ts', kind: 'function', exported: true, line: 1 })
  })

  it('does NOT index test files', () => {
    rebuildIndex({ rootDir: root, scanDirs: ['src', 'scripts'] })
    expect(querySymbolsByName('SHOULD_NOT_INDEX')).toEqual([])
  })

  it('prefixes scripts/ files in the file column (OQ1)', () => {
    rebuildIndex({ rootDir: root, scanDirs: ['src', 'scripts'] })
    expect(querySymbolsByName('runTool')[0]?.file).toBe('scripts/tool.ts')
  })

  it('records import edges resolvable by importers query (CT-AC3)', () => {
    rebuildIndex({ rootDir: root, scanDirs: ['src', 'scripts'] })
    const importers = queryImporters('src/db.ts').map((r) => r.from_file).sort()
    expect(importers).toContain('src/server.ts')
    expect(importers).toContain('src/web/util.ts')
  })

  it('exports query returns only exported symbols (CT-AC2)', () => {
    rebuildIndex({ rootDir: root, scanDirs: ['src', 'scripts'] })
    const names = queryExportsForFile('src/db.ts').map((e) => e.name)
    expect(names).toContain('saveAgentMemory')
    expect(names).toContain('TABLE')
    expect(names).not.toContain('internal')
  })

  it('writes meta with matching counts (CT-AC4)', () => {
    const summary = rebuildIndex({ rootDir: root, scanDirs: ['src', 'scripts'] })
    const meta = getIndexMeta()!
    expect(meta.files_count).toBe(summary.files_indexed)
    expect(meta.symbols_count).toBe(summary.symbols_indexed)
    expect(meta.imports_count).toBe(summary.imports_indexed)
  })

  it('is idempotent across two runs (CT-AC5)', () => {
    const a = rebuildIndex({ rootDir: root, scanDirs: ['src', 'scripts'] })
    const b = rebuildIndex({ rootDir: root, scanDirs: ['src', 'scripts'] })
    expect(b.symbols_indexed).toBe(a.symbols_indexed)
    expect(querySymbolsByName('saveAgentMemory')).toHaveLength(1)
  })
})
