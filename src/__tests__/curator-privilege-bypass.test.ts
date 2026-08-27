import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb, saveMemory, hybridSearch } from '../noa-memory.js'

// Card SEC/0fd4dbd8: hybridSearch grants curator bypass based on the caller-supplied
// agentId rather than an authenticated identity. Any valid-token holder who sets
// ?agent=applegate in mode=hybrid receives ALL agents' private memories.
//
// Measured on the live endpoint: agent=applegate + mode=hybrid returned 68 cross-agent
// non-shared rows vs 0 for agent=dave + mode=hybrid. Root cause: hybridSearch derives
// bypass = CURATOR_AGENTS.has(agentId) from the query param, unlike getAgentMemories
// and searchAgentMemories which require an explicit curator=true opt-in.
//
// Fix: add curator: boolean = false parameter to hybridSearch. The route does not pass
// it, so the bypass is no longer reachable from the external HTTP surface.
// Future full fix: derive curator status from the auth-bound token identity (card 02da7bb2).
//
// Regression test: asserts that calling hybridSearch('applegate', q) WITHOUT the curator
// flag does NOT return cross-agent private (non-shared) memories.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
})

describe('hybridSearch curator privilege (card 0fd4dbd8)', () => {
  it('does NOT return cross-agent private memories when curator flag is absent', async () => {
    // Arrange: two private memories (one per agent) + one shared.
    saveMemory('applegate', 'applegate private probe content', 'cold')
    saveMemory('dave', 'dave private probe content', 'cold')
    saveMemory('marveen', 'shared probe content', 'shared')

    // Act: caller-supplied agent=applegate, no curator opt-in (the route path).
    const results = await hybridSearch('applegate', 'probe', 50)

    const ids = results.map(m => m.agent_id)
    // Must NOT return dave's private cold memory via curator bypass.
    const crossAgentPrivate = results.filter(
      m => m.agent_id !== 'applegate' && m.category !== 'shared',
    )
    expect(crossAgentPrivate).toHaveLength(0)
    // Must include applegate's own memory.
    expect(ids).toContain('applegate')
    // Shared memory is visible regardless of curator status.
    expect(ids).toContain('marveen')
  })

  it('does return cross-agent memories when curator=true is explicitly passed', async () => {
    // This documents the intended curator path (called only by trusted internal code).
    // The route never passes curator=true, so this path is not externally reachable.
    const results = await hybridSearch('applegate', 'probe', 50, true)

    const crossAgentPrivate = results.filter(
      m => m.agent_id !== 'applegate' && m.category !== 'shared',
    )
    // Curator path bypasses scope: dave's private memory should appear.
    expect(crossAgentPrivate.length).toBeGreaterThan(0)
  })
})
