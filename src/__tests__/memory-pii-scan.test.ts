import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { scanForUnscopedPII } from '../memory-pii-scan.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

function seed(over: { agent_id: string; keywords?: string | null; content?: string; access_scope?: string | null; category?: string }): number {
  const info = getDb().prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords, access_scope)
     VALUES (?, ?, 'semantic', 1.0, 0, 0, ?, ?, 0, ?, ?)`
  ).run('c', over.content ?? 'body', over.agent_id, over.category ?? 'warm', over.keywords ?? null, over.access_scope ?? null)
  return Number(info.lastInsertRowid)
}

describe('PM-AC7 retroactive PII scan (report-only)', () => {
  beforeEach(() => { getDb().prepare('DELETE FROM memories').run() })

  it('reports an unscoped PII row and omits benign + already-scoped rows', () => {
    const pii = seed({ agent_id: 'claudia', keywords: 'orvos, idopont', access_scope: null })
    seed({ agent_id: 'dave', keywords: 'deploy, build', access_scope: null })        // benign
    seed({ agent_id: 'claudia', keywords: 'orvos', access_scope: 'claudia' })          // already scoped
    const report = scanForUnscopedPII(getDb())
    const ids = report.map(r => r.id)
    expect(ids).toContain(pii)
    expect(ids).toHaveLength(1)
    expect(report[0]).toMatchObject({ agent_id: 'claudia', category: 'warm' })
  })

  it('returns an empty report when no rows match (and writes nothing)', () => {
    seed({ agent_id: 'dave', keywords: 'routine build', access_scope: null })
    const before = (getDb().prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c
    expect(scanForUnscopedPII(getDb())).toHaveLength(0)
    const after = (getDb().prepare('SELECT COUNT(*) c FROM memories').get() as { c: number }).c
    expect(after).toBe(before)  // scan mutated nothing
  })
})
