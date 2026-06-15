import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import {
  initDatabase, getDb,
  recallByDateRange, recallSearch,
  getAgentMemories, searchAgentMemories,
  saveAgentMemory, isPotentialPII, resolveAccessScope, ScopedSharedError,
} from '../db.js'

// Isolated in-memory DB; the access_scope migration runs as part of init.
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

// Fixed timestamp well inside any wide date-range query.
const TS = 1_700_000_000
const WIDE = { from: '2000-01-01', to: '2035-01-01' }

function seed(over: {
  agent_id: string; access_scope?: string | null; category?: string
  content?: string; keywords?: string | null
}): number {
  const info = getDb().prepare(
    `INSERT INTO memories
      (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords, access_scope)
     VALUES (?, ?, 'semantic', 1.0, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    'test-chat', over.content ?? 'body', TS, TS,
    over.agent_id, over.category ?? 'hot', over.keywords ?? null, over.access_scope ?? null,
  )
  return Number(info.lastInsertRowid)
}

function wipe() {
  getDb().prepare('DELETE FROM memories').run()
}

describe('PM-AC10 adversarial fixtures (recall paths)', () => {
  beforeEach(wipe)

  it('Fixture 1 -- false-positive: owner DOES see their own scoped memory', () => {
    const id = seed({ agent_id: 'claudia', access_scope: 'claudia', category: 'hot', keywords: 'health' })
    const got = recallByDateRange(WIDE.from, WIDE.to, 'claudia').memories.map(m => m.id)
    expect(got).toContain(id)
  })

  it('Fixture 2 -- false-negative: scoped+shared row is hidden from a non-owner on BOTH recall paths', () => {
    seed({ agent_id: 'claudia', access_scope: 'claudia', category: 'shared', content: 'health data', keywords: 'health' })
    expect(recallByDateRange(WIDE.from, WIDE.to, 'marveen').memories).toHaveLength(0)
    expect(recallSearch('health', 'marveen').memories).toHaveLength(0)
  })

  it('Fixture 3 -- opposing combination: one result set is split correctly in one pass', () => {
    const pub = seed({ agent_id: 'claudia', access_scope: null, category: 'shared', content: 'public tip', keywords: 'tip' })
    const priv = seed({ agent_id: 'claudia', access_scope: 'claudia', category: 'shared', content: 'private health', keywords: 'health tip' })
    const got = recallSearch('tip', 'marveen').memories.map(m => m.id)
    expect(got).toContain(pub)
    expect(got).not.toContain(priv)
  })
})

describe('recall path coverage: agent-only + FTS', () => {
  beforeEach(wipe)

  it('getAgentMemories hides a scoped-shared row from a non-owner but keeps unscoped shared', () => {
    const pub = seed({ agent_id: 'claudia', access_scope: null, category: 'shared' })
    const priv = seed({ agent_id: 'claudia', access_scope: 'claudia', category: 'shared' })
    const ids = getAgentMemories('marveen').map(m => m.id)
    expect(ids).toContain(pub)
    expect(ids).not.toContain(priv)
  })

  it('owner still sees their own scoped row via getAgentMemories', () => {
    const priv = seed({ agent_id: 'claudia', access_scope: 'claudia', category: 'hot' })
    expect(getAgentMemories('claudia').map(m => m.id)).toContain(priv)
  })

  it('searchAgentMemories applies the scope filter (FTS path)', () => {
    seed({ agent_id: 'claudia', access_scope: 'claudia', category: 'shared', content: 'private health note', keywords: 'health' })
    expect(searchAgentMemories('marveen', 'health')).toHaveLength(0)
    expect(searchAgentMemories('claudia', 'health').length).toBeGreaterThan(0)
  })

  it('recallByDateRange without agentId is the operator/admin context (sees scoped)', () => {
    const priv = seed({ agent_id: 'claudia', access_scope: 'claudia', category: 'hot' })
    expect(recallByDateRange(WIDE.from, WIDE.to).memories.map(m => m.id)).toContain(priv)
  })
})

describe('PM-AC5 curator bypass (Applegate allowlist)', () => {
  beforeEach(wipe)

  it('Applegate curator read returns a cross-agent scoped row; standard read does not', () => {
    const priv = seed({ agent_id: 'claudia', access_scope: 'claudia', category: 'hot' })
    expect(getAgentMemories('applegate', 20, true).map(m => m.id)).toContain(priv)
    expect(getAgentMemories('applegate', 20, false).map(m => m.id)).not.toContain(priv)
  })

  it('curator flag for a NON-allowlisted agent is inert (no escalation)', () => {
    const priv = seed({ agent_id: 'claudia', access_scope: 'claudia', category: 'hot' })
    // marveen is not on the allowlist -> curator=true must NOT grant cross-scope access
    expect(getAgentMemories('marveen', 20, true).map(m => m.id)).not.toContain(priv)
  })
})

describe('PM-AC4 PII auto-scope + PM-AC9 scoped+shared guard (write path)', () => {
  beforeEach(wipe)

  it('isPotentialPII matches health, financial and HU-id keywords; ignores benign', () => {
    expect(isPotentialPII('orvos, idopont', 'x')).toBe(true)
    expect(isPotentialPII('hitelkartya', 'x')).toBe(true)
    expect(isPotentialPII('taj', 'x')).toBe(true)
    expect(isPotentialPII(null, 'a doctor appointment')).toBe(true)
    expect(isPotentialPII('deploy, build', 'a routine build note')).toBe(false)
  })

  it('resolveAccessScope: absent => PII auto-scope; explicit null => opt-out; string => as-is', () => {
    expect(resolveAccessScope('claudia', 'warm', 'orvos', 'x', undefined)).toBe('claudia')
    expect(resolveAccessScope('claudia', 'warm', 'orvos', 'x', null)).toBeNull()
    expect(resolveAccessScope('claudia', 'warm', 'deploy', 'x', undefined)).toBeNull()
    expect(resolveAccessScope('claudia', 'warm', 'deploy', 'x', 'claudia')).toBe('claudia')
  })

  it('saveAgentMemory auto-scopes a PII write to the author', () => {
    const { id } = saveAgentMemory('claudia', 'orvos idopont holnap', 'warm', 'orvos')
    const row = getDb().prepare('SELECT access_scope FROM memories WHERE id = ?').get(id) as { access_scope: string | null }
    expect(row.access_scope).toBe('claudia')
  })

  it('saveAgentMemory honours an explicit null opt-out even for PII', () => {
    const { id } = saveAgentMemory('claudia', 'orvos idopont', 'warm', 'orvos', false, null)
    const row = getDb().prepare('SELECT access_scope FROM memories WHERE id = ?').get(id) as { access_scope: string | null }
    expect(row.access_scope).toBeNull()
  })

  it('saveAgentMemory rejects an explicit scoped+shared combination (PM-AC9)', () => {
    expect(() => saveAgentMemory('claudia', 'x', 'shared', 'tip', false, 'claudia')).toThrow(ScopedSharedError)
  })

  it('saveAgentMemory rejects a PII write to category=shared (auto-scope would contradict)', () => {
    expect(() => saveAgentMemory('claudia', 'orvos', 'shared', 'orvos')).toThrow(ScopedSharedError)
  })

  it('a non-PII shared write is stored unscoped (unchanged behavior)', () => {
    const { id } = saveAgentMemory('claudia', 'general tip', 'shared', 'tip')
    const row = getDb().prepare('SELECT access_scope FROM memories WHERE id = ?').get(id) as { access_scope: string | null }
    expect(row.access_scope).toBeNull()
  })
})
