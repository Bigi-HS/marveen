import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  initNoaDb,
  getNoaDb,
  saveMemory,
  searchMemories,
  getMemories,
  touchMemory,
  deleteMemory,
  runTierDemotionSweep,
  getEmbedding,
  appendDailyLog,
  getDailyLog,
  getMemoryStats,
  validateOllamaUrl,
  InvalidCategoryError,
  ScopedSharedError,
  // W0a gap-fill exports
  saveAgentMemory,
  getAgentMemories,
  searchAgentMemories,
  updateMemory,
  patchMemory,
  type MemoryPatch,
  hybridSearch,
  backfillEmbeddings,
  applyScopeFilter,
  getDailyLogDates,
  recallByDateRange,
  recallSearch,
  type RecallResult,
  type BackfillResult,
} from '../noa-memory.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
})

function wipeMemories() {
  getNoaDb().prepare('DELETE FROM memories').run()
  getNoaDb().prepare('DELETE FROM embedding_cache').run()
}

function wipeLogs() {
  getNoaDb().prepare('DELETE FROM daily_logs').run()
}

// Seed a memory directly into noa.db (bypassing saveMemory's async embedding kick-off)
function seedRaw(over: {
  agent_id: string
  category?: string
  content?: string
  keywords?: string | null
  access_scope?: string | null
  accessed_at?: number
  embedding?: Buffer | null
}): number {
  const now = Math.floor(Date.now() / 1000)
  const info = getNoaDb().prepare(
    `INSERT INTO memories (agent_id, category, content, keywords, topic_key, access_scope, embedding, created_at, accessed_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`
  ).run(
    over.agent_id,
    over.category ?? 'hot',
    over.content ?? 'test content',
    over.keywords ?? null,
    over.access_scope ?? null,
    over.embedding ?? null,
    now,
    over.accessed_at ?? now,
  )
  return Number(info.lastInsertRowid)
}

// ---- Section 6 DoD assertions ----

describe('AC-1: category validation', () => {
  it('saveMemory throws InvalidCategoryError for invalid category', () => {
    expect(() => saveMemory('dave', 'content', 'general' as never)).toThrow(InvalidCategoryError)
    expect(() => saveMemory('dave', 'content', 'invalid' as never)).toThrow(InvalidCategoryError)
  })

  it('saveMemory accepts all four valid categories', () => {
    for (const cat of ['hot', 'warm', 'cold', 'shared'] as const) {
      expect(() => saveMemory('dave', `content ${cat}`, cat)).not.toThrow()
    }
  })
})

describe('AC-3: saveMemory write path', () => {
  beforeEach(wipeMemories)

  it('inserts a row; memories_fts count increases by 1', () => {
    const before = (getNoaDb().prepare('SELECT COUNT(*) as c FROM memories_fts').get() as { c: number }).c
    saveMemory('dave', 'test memory insert', 'warm')
    const after = (getNoaDb().prepare('SELECT COUNT(*) as c FROM memories_fts').get() as { c: number }).c
    expect(after).toBe(before + 1)
  })

  it('PII keyword in content sets access_scope = agentId', () => {
    const { id } = saveMemory('dave', 'my bank account 12345', 'hot')
    const row = getNoaDb().prepare('SELECT access_scope FROM memories WHERE id = ?').get(id) as { access_scope: string | null }
    expect(row.access_scope).toBe('dave')
  })

  it('PII keyword in content with explicit accessScope=null: stored NULL', () => {
    const { id } = saveMemory('dave', 'my bank account details', 'hot', undefined, null)
    const row = getNoaDb().prepare('SELECT access_scope FROM memories WHERE id = ?').get(id) as { access_scope: string | null }
    expect(row.access_scope).toBeNull()
  })

  it('category=shared + accessScope=undefined + PII content throws ScopedSharedError', () => {
    expect(() => saveMemory('dave', 'bank account 12345', 'shared')).toThrow(ScopedSharedError)
  })

  it('category=shared + accessScope=null + PII content: stored OK (no error)', () => {
    expect(() => saveMemory('dave', 'bank account shared info', 'shared', undefined, null)).not.toThrow()
  })
})

describe('AC-2: runTierDemotionSweep', () => {
  beforeEach(wipeMemories)

  it('hot memory with old accessed_at is demoted to warm', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 3 * 86400
    const id = seedRaw({ agent_id: 'dave', category: 'hot', accessed_at: oldTs })
    const result = runTierDemotionSweep()
    expect(result.hotToWarm).toBeGreaterThanOrEqual(1)
    const row = getNoaDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('warm')
  })

  it('one-level-per-sweep: hot with very old accessed_at goes to warm, not cold', () => {
    const veryOldTs = Math.floor(Date.now() / 1000) - 100 * 86400
    const id = seedRaw({ agent_id: 'dave', category: 'hot', accessed_at: veryOldTs })
    runTierDemotionSweep()
    const row = getNoaDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('warm')
  })

  it('warm memory with old accessed_at is demoted to cold', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 50 * 86400
    const id = seedRaw({ agent_id: 'dave', category: 'warm', accessed_at: oldTs })
    runTierDemotionSweep()
    const row = getNoaDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('cold')
  })

  it('shared memory is never demoted', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 100 * 86400
    const id = seedRaw({ agent_id: 'dave', category: 'shared', accessed_at: oldTs })
    runTierDemotionSweep()
    const row = getNoaDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('shared')
  })

  it('is idempotent: re-running produces 0 changes', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 3 * 86400
    seedRaw({ agent_id: 'dave', category: 'hot', accessed_at: oldTs })
    runTierDemotionSweep()
    const second = runTierDemotionSweep()
    expect(second.hotToWarm).toBe(0)
  })

  it('returns zero counts on fresh DB with no qualifying memories', () => {
    const result = runTierDemotionSweep()
    expect(result).toEqual({ hotToWarm: 0, warmToCold: 0 })
  })
})

describe('AC-4: searchMemories access_scope filter', () => {
  beforeEach(wipeMemories)

  it('scoped memory (agent A) is NOT returned for agent B', async () => {
    seedRaw({ agent_id: 'claudia', content: 'secret info', keywords: 'secret', access_scope: 'claudia', category: 'hot' })
    const results = await searchMemories('dave', 'secret')
    expect(results.map(r => r.agent_id)).not.toContain('claudia')
  })

  it('unscoped shared memory is returned for any agent', async () => {
    const id = seedRaw({ agent_id: 'claudia', content: 'shared tip', keywords: 'tip', category: 'shared', access_scope: null })
    const results = await searchMemories('dave', 'tip')
    expect(results.map(r => r.id)).toContain(id)
  })

  it('returns empty array on empty query', async () => {
    seedRaw({ agent_id: 'dave', content: 'anything', keywords: 'key' })
    const results = await searchMemories('dave', '')
    expect(results).toHaveLength(0)
  })

  it('sqlite-vec unavailable: searchMemories returns FTS5 results without throwing', async () => {
    seedRaw({ agent_id: 'dave', content: 'vec test content', keywords: 'vectest' })
    await expect(searchMemories('dave', 'vectest')).resolves.not.toThrow()
  })
})

describe('AC-7: getEmbedding cache', () => {
  beforeEach(wipeMemories)

  it('second call with same input hits cache (no new Ollama request)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await getEmbedding('test cache text')
    await getEmbedding('test cache text')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('returns null when Ollama is unavailable (throws)', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', mockFetch)

    const result = await getEmbedding('some unique text abc123')
    expect(result).toBeNull()
    vi.unstubAllGlobals()
  })

  it('returns Float32Array on success', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      json: async () => ({ embedding: [0.5, 0.6, 0.7] }),
    })
    vi.stubGlobal('fetch', mockFetch)
    const result = await getEmbedding('float test xyz789')
    expect(result).toBeInstanceOf(Float32Array)
    vi.unstubAllGlobals()
  })
})

describe('AC-8: curator bypass (applegate)', () => {
  beforeEach(wipeMemories)

  it('non-curator agent does not see other agent scoped memory', async () => {
    seedRaw({ agent_id: 'claudia', content: 'private claudia data', keywords: 'private', access_scope: 'claudia', category: 'hot' })
    const results = await searchMemories('dave', 'private')
    expect(results).toHaveLength(0)
  })

  it('applegate (curator) sees all memories', async () => {
    const id = seedRaw({ agent_id: 'claudia', content: 'curator only data', keywords: 'curatoronly', access_scope: 'claudia', category: 'hot' })
    const results = await searchMemories('applegate', 'curatoronly')
    expect(results.map(r => r.id)).toContain(id)
  })
})

describe('AC-11: deleteMemory', () => {
  beforeEach(wipeMemories)

  it('agent B cannot delete agent A row (returns false, row persists)', () => {
    const id = seedRaw({ agent_id: 'claudia', category: 'hot' })
    const result = deleteMemory(id, 'dave')
    expect(result).toBe(false)
    const row = getNoaDb().prepare('SELECT id FROM memories WHERE id = ?').get(id)
    expect(row).not.toBeUndefined()
  })

  it('agent can delete their own row (returns true)', () => {
    const id = seedRaw({ agent_id: 'dave', category: 'hot' })
    const result = deleteMemory(id, 'dave')
    expect(result).toBe(true)
    const row = getNoaDb().prepare('SELECT id FROM memories WHERE id = ?').get(id)
    expect(row).toBeUndefined()
  })

  it('curator (applegate) can delete any row', () => {
    const id = seedRaw({ agent_id: 'claudia', category: 'hot' })
    const result = deleteMemory(id, 'applegate')
    expect(result).toBe(true)
  })

  it('deleteMemory on non-existent id returns false', () => {
    expect(deleteMemory(999999, 'dave')).toBe(false)
  })
})

describe('AC-9: daily log', () => {
  beforeEach(wipeLogs)

  it('appendDailyLog + getDailyLog returns the appended entry', () => {
    const since = Math.floor(Date.now() / 1000) - 1
    appendDailyLog('dave', 'completed task X')
    const entries = getDailyLog('dave', since)
    expect(entries).toHaveLength(1)
    expect(entries[0].content).toBe('completed task X')
    expect(entries[0].agent_id).toBe('dave')
  })

  it('getDailyLog returns entries since timestamp, sorted ASC', () => {
    const now = Math.floor(Date.now() / 1000)
    appendDailyLog('dave', 'first entry')
    appendDailyLog('dave', 'second entry')
    const entries = getDailyLog('dave', now - 1)
    expect(entries.length).toBeGreaterThanOrEqual(2)
    expect(entries[0].created_at).toBeLessThanOrEqual(entries[1].created_at)
  })

  it('getDailyLog excludes entries before since', () => {
    const future = Math.floor(Date.now() / 1000) + 9999
    appendDailyLog('dave', 'old entry')
    const entries = getDailyLog('dave', future)
    expect(entries).toHaveLength(0)
  })
})

describe('AC-12: getMemoryStats', () => {
  beforeEach(wipeMemories)

  it('byTier counts match GROUP BY query', () => {
    seedRaw({ agent_id: 'dave', category: 'hot' })
    seedRaw({ agent_id: 'dave', category: 'hot' })
    seedRaw({ agent_id: 'dave', category: 'warm' })
    seedRaw({ agent_id: 'claudia', category: 'cold' })

    const stats = getMemoryStats()
    const directTier = getNoaDb().prepare('SELECT category, COUNT(*) as c FROM memories GROUP BY category').all() as { category: string; c: number }[]
    const direct: Record<string, number> = {}
    for (const r of directTier) direct[r.category] = r.c

    expect(stats.byTier).toEqual(direct)
    expect(stats.total).toBe(4)
  })

  it('withEmbedding counts only non-null embeddings', () => {
    const buf = Buffer.alloc(12) // 3 floats
    seedRaw({ agent_id: 'dave', category: 'hot', embedding: buf })
    seedRaw({ agent_id: 'dave', category: 'warm', embedding: null })
    const stats = getMemoryStats()
    expect(stats.withEmbedding).toBeGreaterThanOrEqual(1)
  })
})

describe('AC-13: connection PRAGMAs', () => {
  it('journal_mode pragma was applied (wal for file DB; memory for :memory: test DB)', () => {
    // In production (file-backed DB), this is 'wal'. In tests (:memory:), SQLite
    // cannot use WAL mode and returns 'memory' -- the impl verifies WAL only for file paths.
    const jm = (getNoaDb().pragma('journal_mode') as Array<{ journal_mode: string }>)[0]?.journal_mode
    expect(['wal', 'memory']).toContain(jm)
  })

  it('foreign_keys = 1 after connection init', () => {
    const fk = (getNoaDb().pragma('foreign_keys') as Array<{ foreign_keys: number }>)[0]?.foreign_keys
    expect(fk).toBe(1)
  })

  it('busy_timeout = 5000 after connection init', () => {
    const bt = (getNoaDb().pragma('busy_timeout') as Array<{ timeout: number }>)[0]?.timeout
    expect(bt).toBe(5000)
  })
})

describe('I1: OLLAMA_URL validation', () => {
  it('validateOllamaUrl passes for localhost', () => {
    expect(() => validateOllamaUrl('http://localhost:11434')).not.toThrow()
    expect(() => validateOllamaUrl('http://127.0.0.1:11434')).not.toThrow()
    expect(() => validateOllamaUrl('http://[::1]:11434')).not.toThrow()
  })

  it('validateOllamaUrl throws for non-localhost URLs', () => {
    expect(() => validateOllamaUrl('http://remote.host:11434')).toThrow()
    expect(() => validateOllamaUrl('https://api.openai.com/v1')).toThrow()
  })

  it('validateOllamaUrl throws for malformed URL', () => {
    expect(() => validateOllamaUrl('not-a-url')).toThrow()
  })
})

describe('AC-10: touchMemory and getMemories', () => {
  beforeEach(wipeMemories)

  it('touchMemory updates accessed_at', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 1000
    const id = seedRaw({ agent_id: 'dave', category: 'hot', accessed_at: oldTs })
    touchMemory(id)
    const row = getNoaDb().prepare('SELECT accessed_at FROM memories WHERE id = ?').get(id) as { accessed_at: number }
    expect(row.accessed_at).toBeGreaterThan(oldTs)
  })

  it('touchMemory on non-existent id does nothing', () => {
    expect(() => touchMemory(999999)).not.toThrow()
  })

  it('getMemories returns own + shared memories', () => {
    const id1 = seedRaw({ agent_id: 'dave', category: 'hot' })
    const id2 = seedRaw({ agent_id: 'claudia', category: 'shared', access_scope: null })
    const id3 = seedRaw({ agent_id: 'claudia', category: 'hot' })
    const results = getMemories('dave')
    const ids = results.map(r => r.id)
    expect(ids).toContain(id1)
    expect(ids).toContain(id2)
    expect(ids).not.toContain(id3)
  })
})

// ============================================================================
// W0a: Gap-fill exports for route wiring
// ============================================================================

describe('W0a: saveAgentMemory adapter', () => {
  beforeEach(wipeMemories)

  it('saves a memory and returns { id: number }', () => {
    const result = saveAgentMemory('dave', 'route-wired content', 'warm')
    expect(result).toHaveProperty('id')
    expect(typeof result.id).toBe('number')
  })

  it('autoGenerated argument is silently ignored (slim schema has no column)', () => {
    expect(() => saveAgentMemory('dave', 'auto test', 'warm', undefined, true)).not.toThrow()
    expect(() => saveAgentMemory('dave', 'auto test 2', 'warm', undefined, false)).not.toThrow()
  })

  it('passes accessScope through to resolveAccessScope', () => {
    const { id } = saveAgentMemory('dave', 'explicit null scope', 'hot', undefined, false, null)
    const row = getNoaDb().prepare('SELECT access_scope FROM memories WHERE id = ?').get(id) as { access_scope: string | null }
    expect(row.access_scope).toBeNull()
  })

  it('throws InvalidCategoryError for invalid category', () => {
    expect(() => saveAgentMemory('dave', 'x', 'invalid' as never)).toThrow(InvalidCategoryError)
  })
})

describe('W0a: getAgentMemories adapter', () => {
  beforeEach(wipeMemories)

  it('returns own + shared memories', () => {
    const id1 = seedRaw({ agent_id: 'dave', category: 'hot' })
    const id2 = seedRaw({ agent_id: 'claudia', category: 'shared', access_scope: null })
    const id3 = seedRaw({ agent_id: 'claudia', category: 'hot' })
    const results = getAgentMemories('dave')
    const ids = results.map(r => r.id)
    expect(ids).toContain(id1)
    expect(ids).toContain(id2)
    expect(ids).not.toContain(id3)
  })

  it('curator=true for applegate sees all memories', () => {
    const id = seedRaw({ agent_id: 'claudia', category: 'hot', access_scope: 'claudia' })
    const results = getAgentMemories('applegate', 100, true)
    expect(results.map(r => r.id)).toContain(id)
  })

  it('curator=true for non-curator agent is inert', () => {
    const id = seedRaw({ agent_id: 'claudia', category: 'hot' })
    const results = getAgentMemories('dave', 100, true)
    expect(results.map(r => r.id)).not.toContain(id)
  })
})

describe('W0a: searchAgentMemories adapter (sync)', () => {
  beforeEach(wipeMemories)

  it('returns matching memories synchronously', () => {
    seedRaw({ agent_id: 'dave', content: 'sync search target', keywords: 'syncsearch' })
    const results = searchAgentMemories('dave', 'syncsearch')
    expect(results.map(r => r.content)).toContain('sync search target')
  })

  it('returns empty array for no matches', () => {
    const results = searchAgentMemories('dave', 'zzznomatch999')
    expect(results).toHaveLength(0)
  })

  it('curator=true for applegate sees cross-agent scoped memories', () => {
    seedRaw({ agent_id: 'claudia', content: 'curator target', keywords: 'curatortarget', access_scope: 'claudia', category: 'hot' })
    const results = searchAgentMemories('applegate', 'curatortarget', 10, true)
    expect(results.map(r => r.agent_id)).toContain('claudia')
  })

  it('curator=true for non-curator agent does not leak other agents scoped memories', () => {
    seedRaw({ agent_id: 'claudia', content: 'private data', keywords: 'privatedata', access_scope: 'claudia', category: 'hot' })
    const results = searchAgentMemories('dave', 'privatedata', 10, true)
    expect(results.map(r => r.agent_id)).not.toContain('claudia')
  })

  it('does not throw on queries containing LIKE wildcard chars (%, _, \\)', () => {
    expect(() => searchAgentMemories('dave', '50%')).not.toThrow()
    expect(() => searchAgentMemories('dave', 'col_name')).not.toThrow()
    expect(() => searchAgentMemories('dave', 'path\\to')).not.toThrow()
  })

  it('LIKE-fallback literal match: % and _ are not treated as wildcards', () => {
    // This tests the escapeLike fix in the catch (LIKE fallback) branch directly via raw SQL,
    // since triggering the FTS5 catch requires a malformed MATCH expression that
    // buildFtsMatchExpression's sanitizer prevents from reaching FTS5.
    const db = getNoaDb()
    const now = Math.floor(Date.now() / 1000)
    // Seed a memory with literal "50%" and one that would be a false positive if % were unescaped
    db.prepare('INSERT INTO memories (agent_id,category,content,keywords,topic_key,access_scope,created_at,accessed_at) VALUES (?,?,?,?,NULL,NULL,?,?)')
      .run('dave', 'warm', 'discount 50% off', null, now, now)
    db.prepare('INSERT INTO memories (agent_id,category,content,keywords,topic_key,access_scope,created_at,accessed_at) VALUES (?,?,?,?,NULL,NULL,?,?)')
      .run('dave', 'warm', 'discount 50X off', null, now, now)

    // Reproduce what the fixed LIKE fallback does: escapeLike then wrap in %..%
    const query = '50%'
    const escaped = query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    const pat = `%${escaped}%`
    const rows = db.prepare("SELECT content FROM memories WHERE agent_id = 'dave' AND content LIKE ? ESCAPE '\\'").all(pat) as { content: string }[]
    const contents = rows.map(r => r.content)
    expect(contents).toContain('discount 50% off')   // literal match
    expect(contents).not.toContain('discount 50X off') // would appear if % were unescaped
  })
})

describe('W0a: updateMemory (full PUT replace)', () => {
  beforeEach(wipeMemories)

  it('updates content and returns true', () => {
    const id = seedRaw({ agent_id: 'dave', content: 'original', category: 'hot' })
    const result = updateMemory(id, 'updated content')
    expect(result).toBe(true)
    const row = getNoaDb().prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string }
    expect(row.content).toBe('updated content')
  })

  it('returns false for non-existent id', () => {
    expect(updateMemory(999999, 'whatever')).toBe(false)
  })

  it('can update category', () => {
    const id = seedRaw({ agent_id: 'dave', category: 'hot' })
    updateMemory(id, 'content', 'cold')
    const row = getNoaDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('cold')
  })

  it('can update agentId and keywords', () => {
    const id = seedRaw({ agent_id: 'dave', content: 'test', keywords: null, category: 'warm' })
    updateMemory(id, 'test', undefined, 'morgan', 'kw1 kw2')
    const row = getNoaDb().prepare('SELECT agent_id, keywords FROM memories WHERE id = ?').get(id) as { agent_id: string; keywords: string }
    expect(row.agent_id).toBe('morgan')
    expect(row.keywords).toBe('kw1 kw2')
  })
})

describe('W0a: patchMemory (partial update)', () => {
  beforeEach(wipeMemories)

  it('patching category only returns ["category"]', () => {
    const id = seedRaw({ agent_id: 'dave', category: 'hot' })
    const updated = patchMemory(id, { category: 'cold' })
    expect(updated).toEqual(['category'])
    const row = getNoaDb().prepare('SELECT category FROM memories WHERE id = ?').get(id) as { category: string }
    expect(row.category).toBe('cold')
  })

  it('patching content returns ["content"]', () => {
    const id = seedRaw({ agent_id: 'dave', content: 'old', category: 'warm' })
    const updated = patchMemory(id, { content: 'new content' })
    expect(updated).toContain('content')
    const row = getNoaDb().prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string }
    expect(row.content).toBe('new content')
  })

  it('patching multiple fields returns all changed field names', () => {
    const id = seedRaw({ agent_id: 'dave', category: 'hot' })
    const updated = patchMemory(id, { category: 'warm', keywords: 'kw' })
    expect(updated).toContain('category')
    expect(updated).toContain('keywords')
  })

  it('returns [] for non-existent id', () => {
    expect(patchMemory(999999, { category: 'warm' })).toEqual([])
  })

  it('returns [] when no mutable fields provided', () => {
    const id = seedRaw({ agent_id: 'dave', category: 'hot' })
    const updated = patchMemory(id, {} satisfies MemoryPatch)
    expect(updated).toEqual([])
  })

  it('keywords: null clears the column', () => {
    const id = seedRaw({ agent_id: 'dave', keywords: 'existing', category: 'warm' })
    patchMemory(id, { keywords: null })
    const row = getNoaDb().prepare('SELECT keywords FROM memories WHERE id = ?').get(id) as { keywords: string | null }
    expect(row.keywords).toBeNull()
  })
})

describe('W0a: hybridSearch (async RRF)', () => {
  beforeEach(wipeMemories)

  it('returns an array without throwing', async () => {
    seedRaw({ agent_id: 'dave', content: 'hybrid search test', keywords: 'hybridsearch' })
    const results = await hybridSearch('dave', 'hybridsearch')
    expect(Array.isArray(results)).toBe(true)
  })

  it('respects access_scope filter', async () => {
    seedRaw({ agent_id: 'claudia', content: 'private hybrid', keywords: 'privatehybrid', access_scope: 'claudia', category: 'hot' })
    const results = await hybridSearch('dave', 'privatehybrid')
    expect(results.map(r => r.agent_id)).not.toContain('claudia')
  })

  it('applegate curator sees cross-agent results (requires explicit curator=true, card 0fd4dbd8)', async () => {
    // curator=true is the opt-in flag; without it the bypass does not fire even for
    // CURATOR_AGENTS members (prevents HTTP caller spoofing ?agent=applegate).
    const id = seedRaw({ agent_id: 'claudia', content: 'curator hybrid data', keywords: 'curatorhybrid', access_scope: 'claudia', category: 'hot' })
    const results = await hybridSearch('applegate', 'curatorhybrid', 10, true)
    expect(results.map(r => r.id)).toContain(id)
  })
})

describe('W0a: backfillEmbeddings', () => {
  beforeEach(wipeMemories)

  it('returns BackfillResult shape with zero total when no NULL embeddings', async () => {
    const result = await backfillEmbeddings()
    expect(result).toHaveProperty('total')
    expect(result).toHaveProperty('succeeded')
    expect(result).toHaveProperty('failed')
    expect(result).toHaveProperty('aborted')
    expect(result.total).toBe(0)
  })

  it('calls inject embed fn for each NULL embedding memory', async () => {
    seedRaw({ agent_id: 'dave', content: 'needs embedding', embedding: null, category: 'warm' })
    seedRaw({ agent_id: 'dave', content: 'also needs', embedding: null, category: 'warm' })
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    const result = await backfillEmbeddings({ embed })
    expect(embed).toHaveBeenCalledTimes(2)
    expect(result.total).toBe(2)
    expect(result.succeeded).toBe(2)
  })

  it('aborts after 3 consecutive embed failures and sets aborted=true', async () => {
    for (let i = 0; i < 5; i++) {
      seedRaw({ agent_id: 'dave', content: `fail ${i}`, embedding: null, category: 'warm' })
    }
    const embed = vi.fn().mockResolvedValue(null)
    const result = await backfillEmbeddings({ embed })
    expect(result.aborted).toBe(true)
    expect(result.failed).toBe(3)
  })

  it('skips memories that already have an embedding', async () => {
    const buf = Buffer.alloc(12)
    seedRaw({ agent_id: 'dave', content: 'already embedded', embedding: buf, category: 'warm' })
    const embed = vi.fn().mockResolvedValue([0.1, 0.2])
    const result = await backfillEmbeddings({ embed })
    expect(embed).not.toHaveBeenCalled()
    expect(result.total).toBe(0)
  })
})

describe('W0a: applyScopeFilter (exported)', () => {
  it('filters out memories scoped to a different agent', () => {
    const mems = [
      { id: 1, access_scope: 'claudia' },
      { id: 2, access_scope: null },
      { id: 3, access_scope: 'dave' },
    ] as { id: number; access_scope: string | null }[]
    const result = applyScopeFilter(mems, 'dave')
    const ids = result.map(m => m.id)
    expect(ids).toContain(2)
    expect(ids).toContain(3)
    expect(ids).not.toContain(1)
  })

  it('null agentId returns all memories', () => {
    const mems = [
      { id: 1, access_scope: 'claudia' },
      { id: 2, access_scope: null },
    ] as { id: number; access_scope: string | null }[]
    const result = applyScopeFilter(mems, null)
    expect(result).toHaveLength(2)
  })
})

describe('W0a: getDailyLogDates', () => {
  beforeEach(wipeLogs)

  it('returns empty array when no logs exist', () => {
    expect(getDailyLogDates('dave')).toHaveLength(0)
  })

  it('returns distinct dates sorted DESC', () => {
    const db = getNoaDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare("INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)").run('dave', '2026-06-20', 'entry 1', now)
    db.prepare("INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)").run('dave', '2026-06-20', 'entry 2', now)
    db.prepare("INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)").run('dave', '2026-06-21', 'entry 3', now)
    const dates = getDailyLogDates('dave')
    expect(dates).toEqual(['2026-06-21', '2026-06-20'])
  })

  it('only returns dates for the specified agent', () => {
    const db = getNoaDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare("INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)").run('dave', '2026-06-22', 'dave entry', now)
    db.prepare("INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)").run('claudia', '2026-06-22', 'claudia entry', now)
    const dates = getDailyLogDates('dave')
    expect(dates).toContain('2026-06-22')
    const claudiaDates = getDailyLogDates('claudia')
    expect(claudiaDates).toContain('2026-06-22')
    // dave's result should not depend on claudia's entries
    expect(getDailyLogDates('dave').length).toBe(dates.length)
  })

  it('respects limit parameter', () => {
    const db = getNoaDb()
    const now = Math.floor(Date.now() / 1000)
    for (let i = 1; i <= 5; i++) {
      db.prepare("INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)").run('dave', `2026-06-${String(i).padStart(2, '0')}`, `e${i}`, now)
    }
    const dates = getDailyLogDates('dave', 3)
    expect(dates).toHaveLength(3)
  })
})

describe('W0a: recallByDateRange', () => {
  beforeEach(() => { wipeMemories(); wipeLogs() })

  it('returns RecallResult shape', () => {
    const result = recallByDateRange('2026-06-01', '2026-06-30')
    expect(result).toHaveProperty('logs')
    expect(result).toHaveProperty('memories')
    expect(result).toHaveProperty('dateRange')
    expect(result.dateRange.from).toBe('2026-06-01')
    expect(result.dateRange.to).toBe('2026-06-30')
    expect(Array.isArray(result.logs)).toBe(true)
    expect(Array.isArray(result.memories)).toBe(true)
  })

  it('filters logs by date range', () => {
    const db = getNoaDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare("INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)").run('dave', '2026-06-15', 'in range', now)
    db.prepare("INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)").run('dave', '2026-07-01', 'out of range', now)
    const result = recallByDateRange('2026-06-01', '2026-06-30', 'dave')
    const contents = result.logs.map(l => l.content)
    expect(contents).toContain('in range')
    expect(contents).not.toContain('out of range')
  })

  it('respects access_scope in memories (applyScopeFilter applied)', () => {
    const ts = Math.floor(new Date('2026-06-15T12:00:00Z').getTime() / 1000)
    seedRaw({ agent_id: 'claudia', content: 'scoped memory', access_scope: 'claudia', category: 'hot', accessed_at: ts })
    // Override created_at to be within range -- use seedRaw then UPDATE
    const id = getNoaDb().prepare("SELECT id FROM memories WHERE content = 'scoped memory'").get() as { id: number }
    getNoaDb().prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(ts, id.id)
    const result = recallByDateRange('2026-06-01', '2026-06-30', 'dave')
    expect(result.memories.map(m => m.agent_id)).not.toContain('claudia')
  })
})

describe('b32abe01: backfillEmbeddings categories filter', () => {
  beforeEach(wipeMemories)

  it('default (no categories) skips cold memories', async () => {
    seedRaw({ agent_id: 'dave', content: 'hot mem', embedding: null, category: 'hot' })
    seedRaw({ agent_id: 'dave', content: 'cold mem', embedding: null, category: 'cold' })
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    const result = await backfillEmbeddings({ embed })
    // only the hot memory was processed (cold excluded by default)
    expect(result.total).toBe(1)
    expect(result.succeeded).toBe(1)
    const rows = getNoaDb().prepare('SELECT content, embedding FROM memories').all() as { content: string; embedding: Buffer | null }[]
    const hot = rows.find(r => r.content === 'hot mem')!
    const cold = rows.find(r => r.content === 'cold mem')!
    expect(hot.embedding).not.toBeNull()
    expect(cold.embedding).toBeNull()
  })

  it('categories: ["warm"] only processes warm, skips hot/cold/shared', async () => {
    seedRaw({ agent_id: 'dave', content: 'hot mem', embedding: null, category: 'hot' })
    seedRaw({ agent_id: 'dave', content: 'warm mem', embedding: null, category: 'warm' })
    seedRaw({ agent_id: 'dave', content: 'cold mem', embedding: null, category: 'cold' })
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    const result = await backfillEmbeddings({ categories: ['warm'], embed })
    expect(result.total).toBe(1)
    expect(result.succeeded).toBe(1)
    const rows = getNoaDb().prepare('SELECT content, embedding FROM memories').all() as { content: string; embedding: Buffer | null }[]
    expect(rows.find(r => r.content === 'warm mem')!.embedding).not.toBeNull()
    expect(rows.find(r => r.content === 'hot mem')!.embedding).toBeNull()
    expect(rows.find(r => r.content === 'cold mem')!.embedding).toBeNull()
  })

  it('categories: [] processes all categories including cold', async () => {
    seedRaw({ agent_id: 'dave', content: 'hot mem', embedding: null, category: 'hot' })
    seedRaw({ agent_id: 'dave', content: 'cold mem', embedding: null, category: 'cold' })
    const embed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    const result = await backfillEmbeddings({ categories: [], embed })
    expect(result.total).toBe(2)
    expect(result.succeeded).toBe(2)
  })

  it('hot/warm/shared all processed by default', async () => {
    seedRaw({ agent_id: 'dave', content: 'hot', embedding: null, category: 'hot' })
    seedRaw({ agent_id: 'dave', content: 'warm', embedding: null, category: 'warm' })
    seedRaw({ agent_id: 'dave', content: 'shared', embedding: null, category: 'shared' })
    seedRaw({ agent_id: 'dave', content: 'cold', embedding: null, category: 'cold' })
    const embed = vi.fn().mockResolvedValue([0.1, 0.2])
    const result = await backfillEmbeddings({ embed })
    expect(result.total).toBe(3)
    expect(result.succeeded).toBe(3)
  })
})

describe('W0a: recallSearch', () => {
  beforeEach(() => { wipeMemories(); wipeLogs() })

  it('returns RecallResult shape', () => {
    const result = recallSearch('test query')
    expect(result).toHaveProperty('logs')
    expect(result).toHaveProperty('memories')
    expect(result).toHaveProperty('dateRange')
  })

  it('finds memories matching the query', () => {
    seedRaw({ agent_id: 'dave', content: 'recall search content', keywords: 'recallsearch', category: 'warm' })
    const result = recallSearch('recallsearch', 'dave')
    expect(result.memories.map(m => m.content)).toContain('recall search content')
  })

  it('finds logs matching the query', () => {
    const db = getNoaDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare("INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)").run('dave', '2026-06-25', 'log search target', now)
    const result = recallSearch('log search target', 'dave')
    expect(result.logs.map(l => l.content)).toContain('log search target')
  })

  it('respects access_scope filter', () => {
    seedRaw({ agent_id: 'claudia', content: 'private recall', keywords: 'privaterecall', access_scope: 'claudia', category: 'hot' })
    const result = recallSearch('privaterecall', 'dave')
    expect(result.memories.map(m => m.agent_id)).not.toContain('claudia')
  })
})
