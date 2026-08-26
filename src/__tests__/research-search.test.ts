/**
 * Tests for GET /api/research-search + POST /api/research-search/rebuild (MEM-012, a02dcdef).
 *
 * Uses a temp DB + temp store dir so the test never touches real store/ files.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import {
  applyResearchFtsMigrations,
  rebuildResearchIndex,
  searchResearchDocs,
} from '../web/routes/research-search.js'

const TEST_DB = join(tmpdir(), `test-research-search-${process.pid}.db`)
const TEST_STORE = join(tmpdir(), `test-store-${process.pid}`)

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(TEST_DB)
  // Schema for noa.db (minimal -- research_fts migration is additive)
  const schemaPath = join(__dirname, '..', '..', 'scripts', 'schema-noa.sql')
  try {
    getNoaDb().exec(readFileSync(schemaPath, 'utf-8'))
  } catch { /* already exists */ }
  applyResearchFtsMigrations(getNoaDb())
  mkdirSync(TEST_STORE, { recursive: true })
})

afterAll(() => {
  try { rmSync(TEST_DB, { force: true }) } catch {}
  try { rmSync(TEST_STORE, { recursive: true, force: true }) } catch {}
})

beforeEach(() => {
  getNoaDb().prepare('DELETE FROM research_fts').run()
})

// ---------------------------------------------------------------------------
// rebuildResearchIndex
// ---------------------------------------------------------------------------
describe('rebuildResearchIndex', () => {
  it('indexes research-*.md files from the store dir', () => {
    writeFileSync(join(TEST_STORE, 'research-claude-ai-0801.md'), '# Claude AI research\n\nClaude Code skills and tools.')
    writeFileSync(join(TEST_STORE, 'research-python-0802.md'), '# Python research\n\nPython tooling and libraries.')
    const { indexed } = rebuildResearchIndex(TEST_STORE, getNoaDb())
    expect(indexed).toBe(2)
  })

  it('indexes obsidian-*.md files too', () => {
    writeFileSync(join(TEST_STORE, 'obsidian-notes-0801.md'), '# Obsidian vault notes')
    const { indexed } = rebuildResearchIndex(TEST_STORE, getNoaDb())
    expect(indexed).toBeGreaterThanOrEqual(1)
  })

  it('ignores files that do not match research-* or obsidian-*', () => {
    // cleanup first
    getNoaDb().prepare('DELETE FROM research_fts').run()
    writeFileSync(join(TEST_STORE, 'random-file.md'), '# Not a research doc')
    writeFileSync(join(TEST_STORE, 'research-x.md'), '# Research X')
    const { indexed } = rebuildResearchIndex(TEST_STORE, getNoaDb())
    // Only research-x.md should be indexed (not random-file.md)
    const rows = getNoaDb().prepare('SELECT filename FROM research_fts').all() as Array<{ filename: string }>
    expect(rows.map(r => r.filename)).toContain('research-x.md')
    expect(rows.map(r => r.filename)).not.toContain('random-file.md')
  })

  it('is idempotent: double-rebuild gives same count', () => {
    writeFileSync(join(TEST_STORE, 'research-dup.md'), '# Duplicate test')
    const first = rebuildResearchIndex(TEST_STORE, getNoaDb())
    const second = rebuildResearchIndex(TEST_STORE, getNoaDb())
    expect(first.indexed).toBe(second.indexed)
  })
})

// ---------------------------------------------------------------------------
// searchResearchDocs
// ---------------------------------------------------------------------------
describe('searchResearchDocs', () => {
  it('finds a document by keyword', () => {
    getNoaDb().prepare("INSERT INTO research_fts (filename, content) VALUES (?, ?)").run(
      'research-skills.md', 'Claude Code skill system and toolchain integration.'
    )
    const results = searchResearchDocs('skill', 5, getNoaDb())
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].filename).toBe('research-skills.md')
  })

  it('returns empty for no match', () => {
    const results = searchResearchDocs('xyzzynotexist123456', 5, getNoaDb())
    expect(results).toEqual([])
  })

  it('returns empty for empty query', () => {
    const results = searchResearchDocs('', 5, getNoaDb())
    expect(results).toEqual([])
  })

  it('does not throw on malformed FTS5 query (safe fallback)', () => {
    // Unbalanced parens would normally throw; the handler must not propagate
    expect(() => searchResearchDocs('(((bad query', 5, getNoaDb())).not.toThrow()
  })
})
