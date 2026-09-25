import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDb, initDatabase, startOfBudapestDayMs } from '../db.js'

// WELL-027 audit C5+C6 (card 3f674c34): rate-coverage silent-$0 surface (C5a),
// cursor re-parse idempotency (C5b), Budapest window TZ-pin (C6-TZ), and the
// untagged fable-spend surface (C6a). All exercised against the REAL schema
// (initDatabase creates token_usage + the UNIQUE idx_token_usage_dedup + the
// model / spawned_by columns), so the dedup guarantee under test is production's.

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const NOW_MS = 1_784_000_000_000
const nowSec = Math.floor(NOW_MS / 1000)
const HOUR = 3600
const DAY = 86400

function insertRow(
  agent: string,
  tsSeconds: number,
  model: string | null,
  input = 100,
  output = 20,
): void {
  getDb().prepare(`
    INSERT OR IGNORE INTO token_usage
      (agent, session_id, timestamp, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, model)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?)
  `).run(agent, 'sess-' + tsSeconds, tsSeconds, input, output, model)
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})
beforeEach(() => {
  getDb().exec('DELETE FROM token_usage')
  getDb().exec('DELETE FROM token_usage_cursors')
})

describe('C5a getUnratedModels - unknown/renamed model must not silently price to $0', () => {
  it('surfaces a row whose explicit model is not in the rate registry', async () => {
    const { getUnratedModels } = await import('../web/token-usage.js')
    insertRow('dave', nowSec - HOUR, 'claude-ghost-9', 1000, 200)
    const unrated = getUnratedModels(nowSec - DAY, nowSec)
    const hit = unrated.find((u) => u.model === 'claude-ghost-9')
    expect(hit).toBeDefined()
    expect(hit!.agent).toBe('dave')
    expect(hit!.calls).toBe(1)
    expect(hit!.totalTokens).toBe(1200)
  })

  it('does NOT surface a known, priced model', async () => {
    const { getUnratedModels } = await import('../web/token-usage.js')
    insertRow('dave', nowSec - HOUR, 'claude-opus-4-8', 1000, 200)
    const unrated = getUnratedModels(nowSec - DAY, nowSec)
    expect(unrated.find((u) => u.model === 'claude-opus-4-8')).toBeUndefined()
  })

  it('does NOT surface fable (intentionally unpriced, not "unrated")', async () => {
    const { getUnratedModels } = await import('../web/token-usage.js')
    insertRow('percy', nowSec - HOUR, 'claude-fable-5', 1000, 200)
    const unrated = getUnratedModels(nowSec - DAY, nowSec)
    expect(unrated.find((u) => u.model === 'claude-fable-5')).toBeUndefined()
  })

  it('ignores a bogus-model row that carried zero tokens', async () => {
    const { getUnratedModels } = await import('../web/token-usage.js')
    insertRow('dave', nowSec - HOUR, 'claude-ghost-9', 0, 0)
    const unrated = getUnratedModels(nowSec - DAY, nowSec)
    expect(unrated.find((u) => u.model === 'claude-ghost-9')).toBeUndefined()
  })

  it('aggregates repeated (agent, unknown-model) rows into one entry', async () => {
    const { getUnratedModels } = await import('../web/token-usage.js')
    insertRow('dave', nowSec - HOUR, 'claude-ghost-9', 1000, 200)
    insertRow('dave', nowSec - 2 * HOUR, 'claude-ghost-9', 500, 100)
    const unrated = getUnratedModels(nowSec - DAY, nowSec)
    const hits = unrated.filter((u) => u.model === 'claude-ghost-9' && u.agent === 'dave')
    expect(hits.length).toBe(1)
    expect(hits[0].calls).toBe(2)
    expect(hits[0].totalTokens).toBe(1800)
  })

  it('two agents using the same unknown model yield two SEPARATE entries (GROUP BY agent,model)', async () => {
    // Card 44783957 boundary: `getUnratedModels` groups by (agent, model), NOT just
    // by model. Two agents consuming the same unrecognised model must each produce
    // their own entry so per-agent attribution is preserved.
    //
    // Dangerous direction: if the query used GROUP BY model only, one agent's row
    // would be silently absorbed into the other's total -- the per-agent cost
    // attribution would be wrong and one agent would disappear from the report.
    const { getUnratedModels } = await import('../web/token-usage.js')
    insertRow('dave',  nowSec - HOUR,     'claude-phantom-5', 1000, 200)
    insertRow('forge', nowSec - 2 * HOUR, 'claude-phantom-5',  500, 100)
    const unrated = getUnratedModels(nowSec - DAY, nowSec)
    const hits = unrated.filter((u) => u.model === 'claude-phantom-5')
    expect(hits.length).toBe(2)                          // two agents, two entries
    const daveEntry  = hits.find((u) => u.agent === 'dave')
    const forgeEntry = hits.find((u) => u.agent === 'forge')
    expect(daveEntry).toBeDefined()
    expect(forgeEntry).toBeDefined()
    expect(daveEntry!.totalTokens).toBe(1200)            // 1000+200
    expect(forgeEntry!.totalTokens).toBe(600)            // 500+100
  })
})

describe('C5b ingestJsonlFile - cursor re-parse must be idempotent (no double-count)', () => {
  function writeFixture(dir: string, lines: object[]): string {
    const file = join(dir, 'session-1.jsonl')
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    return file
  }
  function assistantLine(ts: string, input: number, output: number): object {
    return {
      type: 'assistant',
      sessionId: 'sess-replay',
      timestamp: ts,
      message: {
        usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'replay line' }],
      },
    }
  }
  function rowCount(): number {
    return (getDb().prepare('SELECT COUNT(*) as n FROM token_usage').get() as { n: number }).n
  }

  it('re-ingesting an UNCHANGED file is a no-op (cursor size guard)', async () => {
    const { ingestJsonlFile } = await import('../web/token-usage.js')
    const dir = mkdtempSync(join(tmpdir(), 'tu-c5b-'))
    const file = writeFixture(dir, [
      assistantLine('2026-05-20T10:00:00Z', 100, 20),
      assistantLine('2026-05-20T10:01:00Z', 200, 40),
    ])
    const first = await ingestJsonlFile(getDb(), file, 'dave')
    expect(first.processed).toBe(true)
    expect(rowCount()).toBe(2)

    const second = await ingestJsonlFile(getDb(), file, 'dave')
    expect(second.processed).toBe(false)
    expect(second.inserted).toBe(0)
    expect(rowCount()).toBe(2)
  })

  it('a forced re-parse (cursor wiped) does NOT double-count - dedup index holds', async () => {
    const { ingestJsonlFile } = await import('../web/token-usage.js')
    const dir = mkdtempSync(join(tmpdir(), 'tu-c5b-'))
    const file = writeFixture(dir, [
      assistantLine('2026-05-20T10:00:00Z', 100, 20),
      assistantLine('2026-05-20T10:01:00Z', 200, 40),
    ])
    await ingestJsonlFile(getDb(), file, 'dave')
    expect(rowCount()).toBe(2)

    getDb().exec('DELETE FROM token_usage_cursors')
    const reparse = await ingestJsonlFile(getDb(), file, 'dave')
    expect(reparse.processed).toBe(true)
    expect(rowCount()).toBe(2) // stable: overlapping slice re-read, each tuple counted once
  })

  it('an APPENDED line resumes from the cursor and adds exactly the new row', async () => {
    const { ingestJsonlFile } = await import('../web/token-usage.js')
    const dir = mkdtempSync(join(tmpdir(), 'tu-c5b-'))
    const file = writeFixture(dir, [
      assistantLine('2026-05-20T10:00:00Z', 100, 20),
      assistantLine('2026-05-20T10:01:00Z', 200, 40),
    ])
    await ingestJsonlFile(getDb(), file, 'dave')
    expect(rowCount()).toBe(2)

    appendFileSync(file, JSON.stringify(assistantLine('2026-05-20T10:02:00Z', 300, 60)) + '\n')
    const grown = await ingestJsonlFile(getDb(), file, 'dave')
    expect(grown.processed).toBe(true)
    expect(rowCount()).toBe(3) // only the new row, earlier rows not duplicated
  })
})

describe('C6-TZ - fable today-window boundary is Budapest-pinned (DST-exact)', () => {
  it('today.from equals startOfBudapestDayMs(now) in seconds (normal day)', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    const b = getFableBudget({ nowMs: NOW_MS, agentsOnFable: [] })
    expect(b.today.from).toBe(Math.floor(startOfBudapestDayMs(NOW_MS) / 1000))
  })

  it('is correct on a spring-forward DST day (2026-03-29, CET->CEST)', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    // 2026-03-29 spring-forward: 02:00 CET(+1) -> 03:00 CEST(+2). Local midnight
    // 00:00 that day is still CET(+1) = 2026-03-28T23:00:00Z.
    const nowMsDst = Date.UTC(2026, 2, 29, 10, 0, 0) // 12:00 CEST
    const expectedStartSec = Math.floor(Date.UTC(2026, 2, 28, 23, 0, 0) / 1000)
    const b = getFableBudget({ nowMs: nowMsDst, agentsOnFable: [] })
    expect(b.today.from).toBe(expectedStartSec)
  })
})

describe('C6a possiblyUntagged - untagged spend from fable-configured agents is surfaced', () => {
  it('flags a NULL-model row from a fable-configured agent in the week window', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    insertRow('percy', nowSec - 2 * HOUR, null, 1000, 200)
    const b = getFableBudget({ nowMs: NOW_MS, agentsOnFable: ['percy'] })
    expect(b.possiblyUntagged.rows).toBe(1)
    expect(b.possiblyUntagged.tokens).toBe(1200)
    expect(b.possiblyUntagged.agents).toContain('percy')
  })

  it('does NOT flag a NULL-model row from an agent NOT on fable', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    insertRow('dave', nowSec - 2 * HOUR, null, 1000, 200)
    const b = getFableBudget({ nowMs: NOW_MS, agentsOnFable: ['percy'] })
    expect(b.possiblyUntagged.rows).toBe(0)
    expect(b.possiblyUntagged.agents).not.toContain('dave')
  })

  it('does NOT flag a properly fable-tagged row (it is counted normally)', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    insertRow('percy', nowSec - 2 * HOUR, 'claude-fable-5', 1000, 200)
    const b = getFableBudget({ nowMs: NOW_MS, agentsOnFable: ['percy'] })
    expect(b.possiblyUntagged.rows).toBe(0)
    expect(b.week.rows).toBe(1)
  })

  it('is all-zero when nobody is configured on fable', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    insertRow('percy', nowSec - 2 * HOUR, null, 1000, 200)
    const b = getFableBudget({ nowMs: NOW_MS, agentsOnFable: [] })
    expect(b.possiblyUntagged.rows).toBe(0)
    expect(b.possiblyUntagged.agents).toEqual([])
  })

  it('does NOT flag an untagged row OLDER than the week window', async () => {
    const { getFableBudget } = await import('../web/token-usage.js')
    insertRow('percy', nowSec - 8 * DAY, null, 1000, 200)
    const b = getFableBudget({ nowMs: NOW_MS, agentsOnFable: ['percy'] })
    expect(b.possiblyUntagged.rows).toBe(0)
  })
})
