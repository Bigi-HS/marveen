/**
 * W1 route-wiring regression tests for routes/memories.ts -> noa-memory.
 *
 * These tests exercise the noa-memory functions the route calls directly,
 * proving that swapping from db.ts to noa-memory.ts preserves behaviour.
 * The PATCH content round-trip is the explicit regression guard mandated
 * by spec (commit 61063e6 must stay working after the import swap).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

const {
  saveMemory,
  saveAgentMemory,
  patchMemory,
  updateMemory,
  deleteMemory,
  getMemories,
  getAgentMemories,
  searchAgentMemories,
  applyScopeFilter,
  getMemoryStats,
  backfillEmbeddings,
} = await import('../noa-memory.js')
import type { NoaMemory } from '../noa-memory.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
})

function wipe(): void {
  getNoaDb().prepare('DELETE FROM memories').run()
}

// ---------------------------------------------------------------------------
// PATCH content round-trip (regression guard: commit 61063e6 must hold)
// ---------------------------------------------------------------------------

describe('PATCH content regression guard (61063e6)', () => {
  beforeEach(wipe)

  it('patchMemory({content}) persists updated content, not just category', () => {
    const db = getNoaDb()
    const { id } = saveMemory('marveen', 'original content', 'warm')

    const updated = patchMemory(id, { content: 'updated content' })

    expect(updated).toContain('content')
    const row = db.prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string }
    expect(row.content).toBe('updated content')
  })

  it('patchMemory({category}) updates ONLY category, leaves content intact', () => {
    const db = getNoaDb()
    const { id } = saveMemory('marveen', 'important content', 'warm')

    patchMemory(id, { category: 'cold' })

    const row = db.prepare('SELECT content, category FROM memories WHERE id = ?').get(id) as { content: string; category: string }
    expect(row.category).toBe('cold')
    expect(row.content).toBe('important content')
  })

  it('patchMemory({content, category}) persists both fields', () => {
    const db = getNoaDb()
    const { id } = saveMemory('marveen', 'old content', 'hot')

    const updated = patchMemory(id, { content: 'new content', category: 'warm' })

    expect(updated).toContain('content')
    expect(updated).toContain('category')
    const row = db.prepare('SELECT content, category FROM memories WHERE id = ?').get(id) as { content: string; category: string }
    expect(row.content).toBe('new content')
    expect(row.category).toBe('warm')
  })

  it('patchMemory on missing id returns [] (empty updated list)', () => {
    const result = patchMemory(999999, { content: 'no-op' })
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// memoryOwner via getNoaDb (used by PUT/PATCH/DELETE auth in route)
// ---------------------------------------------------------------------------

describe('memoryOwner lookup via getNoaDb', () => {
  beforeEach(wipe)

  it('SELECT agent_id FROM memories WHERE id returns correct owner', () => {
    const db = getNoaDb()
    const { id } = saveMemory('claudia', 'claudia memory', 'warm')
    const row = db.prepare('SELECT agent_id FROM memories WHERE id = ?').get(id) as { agent_id: string } | undefined
    expect(row?.agent_id).toBe('claudia')
  })

  it('missing id returns undefined', () => {
    const db = getNoaDb()
    const row = db.prepare('SELECT agent_id FROM memories WHERE id = ?').get(999999)
    expect(row).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// GET no-q no-agent path: getAgentMemories(MAIN_AGENT_ID) replaces getMemoriesForChat
// ---------------------------------------------------------------------------

describe('GET no-agent path replacement (retire chat_id)', () => {
  beforeEach(wipe)

  it('getAgentMemories(MAIN_AGENT_ID) returns recent memories for main agent', () => {
    saveMemory('marveen', 'memo A', 'warm')
    saveMemory('marveen', 'memo B', 'hot')

    const results = getAgentMemories('marveen', 50)
    expect(results.length).toBeGreaterThanOrEqual(2)
    expect(results.some(m => m.content === 'memo A')).toBe(true)
  })

  it('getAgentMemories(MAIN_AGENT_ID) includes shared memories', () => {
    saveMemory('claudia', 'claudia shared', 'shared')
    saveMemory('marveen', 'marveen own', 'warm')

    const results = getAgentMemories('marveen', 50)
    const contents = results.map(m => m.content)
    // shared memories visible to marveen
    expect(contents).toContain('claudia shared')
    expect(contents).toContain('marveen own')
  })
})

// ---------------------------------------------------------------------------
// GET q-only path: searchAgentMemories replaces searchMemories+ALLOWED_CHAT_ID
// ---------------------------------------------------------------------------

describe('GET q-only path (searchAgentMemories for cross-agent fallback)', () => {
  beforeEach(wipe)

  it('searchAgentMemories finds memory by keyword', () => {
    saveMemory('marveen', 'Budapest weather is sunny', 'warm')
    const results = searchAgentMemories('marveen', 'Budapest', 10)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some(m => m.content.includes('Budapest'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// saveAgentMemory compatibility (POST handler, incl. autoGenerated ignored)
// ---------------------------------------------------------------------------

describe('saveAgentMemory compatibility', () => {
  beforeEach(wipe)

  it('saveAgentMemory stores memory and returns id', () => {
    const result = saveAgentMemory('marveen', 'test content', 'warm', 'kw', true)
    expect(result.id).toBeGreaterThan(0)
    const row = getNoaDb().prepare('SELECT content FROM memories WHERE id = ?').get(result.id) as { content: string }
    expect(row.content).toBe('test content')
  })
})

// ---------------------------------------------------------------------------
// DELETE via deleteMemory(id, owner) -- auth was already done by route
// ---------------------------------------------------------------------------

describe('DELETE via deleteMemory', () => {
  beforeEach(wipe)

  it('deleteMemory removes the row and returns true', () => {
    const db = getNoaDb()
    const { id } = saveMemory('marveen', 'to be deleted', 'hot')
    const ok = deleteMemory(id, 'marveen')
    expect(ok).toBe(true)
    const row = db.prepare('SELECT id FROM memories WHERE id = ?').get(id)
    expect(row).toBeUndefined()
  })

  it('deleteMemory on missing id returns false', () => {
    const ok = deleteMemory(999999, 'marveen')
    expect(ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// applyScopeFilter (PM-AC3 enforcement point unchanged)
// ---------------------------------------------------------------------------

describe('applyScopeFilter', () => {
  it('agentId null -> no filtering (admin/operator path)', () => {
    const rows: NoaMemory[] = [
      { id: 1, agent_id: 'a', category: 'warm', content: 'x', keywords: null, topic_key: null, access_scope: 'a', embedding: null, created_at: 0, accessed_at: 0 },
      { id: 2, agent_id: 'b', category: 'warm', content: 'y', keywords: null, topic_key: null, access_scope: null, embedding: null, created_at: 0, accessed_at: 0 },
    ]
    expect(applyScopeFilter(rows, null)).toHaveLength(2)
  })

  it('agentId set -> filters out other-scoped entries', () => {
    const rows: NoaMemory[] = [
      { id: 1, agent_id: 'a', category: 'warm', content: 'x', keywords: null, topic_key: null, access_scope: 'a', embedding: null, created_at: 0, accessed_at: 0 },
      { id: 2, agent_id: 'b', category: 'warm', content: 'y', keywords: null, topic_key: null, access_scope: 'b', embedding: null, created_at: 0, accessed_at: 0 },
      { id: 3, agent_id: 'a', category: 'shared', content: 'z', keywords: null, topic_key: null, access_scope: null, embedding: null, created_at: 0, accessed_at: 0 },
    ]
    const filtered = applyScopeFilter(rows, 'a')
    expect(filtered.map(m => m.id)).toEqual([1, 3])
  })
})

// ---------------------------------------------------------------------------
// getMemoryStats shape parity
// ---------------------------------------------------------------------------

describe('getMemoryStats', () => {
  beforeEach(wipe)

  it('returns total, byAgent, byTier, withEmbedding shape', () => {
    saveMemory('marveen', 'stat test', 'warm')
    const stats = getMemoryStats()
    expect(typeof stats.total).toBe('number')
    expect(stats.total).toBeGreaterThanOrEqual(1)
    expect(stats.byAgent).toBeDefined()
    expect(stats.byTier).toBeDefined()
    expect(typeof stats.withEmbedding).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// updateMemory (PUT handler)
// ---------------------------------------------------------------------------

describe('updateMemory (PUT path)', () => {
  beforeEach(wipe)

  it('updateMemory replaces content and updates accessed_at', () => {
    const db = getNoaDb()
    const { id } = saveMemory('marveen', 'original', 'warm')
    const before = (db.prepare('SELECT accessed_at FROM memories WHERE id = ?').get(id) as { accessed_at: number }).accessed_at

    const ok = updateMemory(id, 'replaced content', 'hot')
    expect(ok).toBe(true)

    const row = db.prepare('SELECT content, category, accessed_at FROM memories WHERE id = ?').get(id) as { content: string; category: string; accessed_at: number }
    expect(row.content).toBe('replaced content')
    expect(row.category).toBe('hot')
    expect(row.accessed_at).toBeGreaterThanOrEqual(before)
  })
})

// ---------------------------------------------------------------------------
// b32abe01: /api/memories/reembed -- thin wrapper contract
// ---------------------------------------------------------------------------

describe('b32abe01: backfillEmbeddings called by reembed route (contract)', () => {
  beforeEach(wipe)

  it('categories filter: only warm processed', async () => {
    // Seed raw rows (no embedding) across tiers
    const db = getNoaDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      'INSERT INTO memories (agent_id, category, content, keywords, topic_key, access_scope, embedding, created_at, accessed_at) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)'
    ).run('dave', 'warm', 'warm target', now, now)
    db.prepare(
      'INSERT INTO memories (agent_id, category, content, keywords, topic_key, access_scope, embedding, created_at, accessed_at) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)'
    ).run('dave', 'cold', 'cold bystander', now, now)

    const embed = vi.fn().mockResolvedValue([0.1, 0.2])
    const r = await backfillEmbeddings({ categories: ['warm'], embed })
    expect(r.total).toBe(1)
    expect(r.succeeded).toBe(1)
    // cold row still NULL
    const cold = db.prepare("SELECT embedding FROM memories WHERE content = 'cold bystander'").get() as { embedding: Buffer | null }
    expect(cold.embedding).toBeNull()
  })

  it('BackfillResult shape: ok=true when not aborted', async () => {
    const r = await backfillEmbeddings({ embed: vi.fn().mockResolvedValue([0.1]) })
    expect(r).toMatchObject({ total: expect.any(Number), succeeded: expect.any(Number), failed: expect.any(Number), aborted: false })
  })
})
