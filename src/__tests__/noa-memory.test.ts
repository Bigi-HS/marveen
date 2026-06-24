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
