import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb, backfillEmbeddings } from '../db.js'

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().prepare('DELETE FROM memories').run()
})

// Insert a memory row directly (bypassing saveAgentMemory's fire-and-forget
// embed) so the backfill is the ONLY thing that writes embeddings in the test.
function insertMemory(content: string, keywords: string | null, embedding: string | null): number {
  const info = getDb()
    .prepare(
      "INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords, embedding)" +
        " VALUES ('c', ?, 'semantic', 1.0, 0, 0, 'dave', 'warm', 0, ?, ?)",
    )
    .run(content, keywords, embedding)
  return Number(info.lastInsertRowid)
}

function embeddingOf(id: number): string | null {
  return (getDb().prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as { embedding: string | null }).embedding
}

describe('backfillEmbeddings', () => {
  it('embeds every NULL row and leaves already-embedded rows untouched', async () => {
    const a = insertMemory('alpha', 'k1', null)
    const b = insertMemory('beta', null, null)
    const kept = insertMemory('gamma', null, '[9,9,9]') // already embedded

    const r = await backfillEmbeddings({ embed: async () => [0.1, 0.2, 0.3] })

    expect(r).toEqual({ total: 2, succeeded: 2, failed: 0, aborted: false })
    expect(JSON.parse(embeddingOf(a)!)).toEqual([0.1, 0.2, 0.3])
    expect(JSON.parse(embeddingOf(b)!)).toEqual([0.1, 0.2, 0.3])
    expect(embeddingOf(kept)).toBe('[9,9,9]') // not re-embedded
  })

  it('appends keywords to the embedded text', async () => {
    insertMemory('content here', 'kw1 kw2', null)
    const seen: string[] = []
    await backfillEmbeddings({
      embed: async (text) => {
        seen.push(text)
        return [1]
      },
    })
    expect(seen).toEqual(['content here kw1 kw2'])
  })

  it('counts an individual failed embedding without aborting', async () => {
    const ok1 = insertMemory('ok-one', null, null)
    const bad = insertMemory('bad', null, null)
    const ok2 = insertMemory('ok-two', null, null)

    const r = await backfillEmbeddings({
      embed: async (text) => (text.startsWith('bad') ? null : [0.5]),
    })

    expect(r.total).toBe(3)
    expect(r.succeeded).toBe(2)
    expect(r.failed).toBe(1)
    expect(r.aborted).toBe(false)
    expect(embeddingOf(ok1)).not.toBeNull()
    expect(embeddingOf(bad)).toBeNull() // stays unembedded
    expect(embeddingOf(ok2)).not.toBeNull()
  })

  it('aborts after 3 consecutive empty embeddings (embedder unreachable)', async () => {
    for (let i = 0; i < 5; i++) insertMemory(`m${i}`, null, null)
    let calls = 0
    const r = await backfillEmbeddings({
      embed: async () => {
        calls++
        return null
      },
    })
    expect(r.total).toBe(5)
    expect(r.succeeded).toBe(0)
    expect(r.failed).toBe(3) // stopped at the 3rd consecutive miss
    expect(r.aborted).toBe(true)
    expect(calls).toBe(3) // did not churn the remaining 2 rows
  })

  it('does not reset the consecutive-fail counter until a success', async () => {
    // 2 fails then a success then 2 fails -> never 3 in a row -> no abort
    insertMemory('f', null, null)
    insertMemory('f', null, null)
    insertMemory('s', null, null)
    insertMemory('f', null, null)
    insertMemory('f', null, null)
    const r = await backfillEmbeddings({
      embed: async (text) => (text.startsWith('s') ? [1] : null),
    })
    expect(r.aborted).toBe(false)
    expect(r.succeeded).toBe(1)
    expect(r.failed).toBe(4)
  })

  it('reports nothing to do when no rows are missing embeddings', async () => {
    insertMemory('already', null, '[1]')
    const r = await backfillEmbeddings({ embed: async () => [0] })
    expect(r).toEqual({ total: 0, succeeded: 0, failed: 0, aborted: false })
  })
})
