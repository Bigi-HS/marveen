import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import {
  initNoaDb,
  getNoaDb,
  getEmbedding,
  getEmbeddingResult,
  classifyEmbedFailure,
  backfillEmbeddings,
  EMBED_TIMEOUT_MS,
  EMBED_WARMUP_TIMEOUT_MS,
} from '../noa-memory.js'
import { tryHandleMemories } from '../web/routes/memories.js'

// Card ENG/811ce3b2 (measured 2026-08-07 by dave, reported by NoA).
//
// The 06:00 backfill reported ok=false / failed=3 / aborted=true and the alert said
// "embedder unreachable". The server log disagreed: three AbortErrors exactly 5.027s
// apart, no ECONNREFUSED. It had CONNECTED and TIMED OUT. Two defects behind one
// symptom, and this file pins both before they are fixed:
//
//   1. The 5s AbortController budget covers the one-time MODEL LOAD as well as the
//      ~50ms embed, so a cold load bills every row. A one-time cost must not be paid
//      out of a per-row budget.
//   2. Three distinct failures (timeout / connection refused / no embedding in the
//      response) all collapse into a single `null`, so the caller cannot tell them
//      apart -- and the alert text picked one of them at random. Same shape on the
//      breaker: with total=3 "the fuse tripped" and "the work list ran out" are the
//      same signal, so `aborted` was reported as evidence for a claim it cannot make.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
})

function wipe() {
  getNoaDb().prepare('DELETE FROM memories').run()
  getNoaDb().prepare('DELETE FROM embedding_cache').run()
}

function seedNull(content: string): number {
  return Number(getNoaDb().prepare(
    `INSERT INTO memories (agent_id, category, content, keywords, topic_key, access_scope, embedding, created_at, accessed_at)
     VALUES ('dave', 'warm', ?, NULL, NULL, NULL, NULL, unixepoch(), unixepoch())`
  ).run(content).lastInsertRowid)
}

/** The shape node's fetch throws on an aborted request. */
function abortError(): Error {
  const err = new Error('This operation was aborted')
  err.name = 'AbortError'
  return err
}

/** The shape node's fetch throws when nothing is listening on the port. */
function refusedError(): Error {
  const err = new TypeError('fetch failed')
  ;(err as unknown as { cause: unknown }).cause = Object.assign(
    new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' },
  )
  return err
}

describe('the three embed failures are three values, not one null', () => {
  it('classifies an AbortError as a timeout, not as unreachable', () => {
    expect(classifyEmbedFailure(abortError())).toBe('timeout')
  })

  it('classifies ECONNREFUSED as a refused connection', () => {
    expect(classifyEmbedFailure(refusedError())).toBe('connection-refused')
  })

  it('says unknown rather than guessing, for an error it cannot place', () => {
    // The point of the card: a cause it has not measured must not be reported as
    // one it has. UNKNOWN is a real answer here.
    expect(classifyEmbedFailure(new Error('something else entirely'))).toBe('unknown')
  })
})

describe('getEmbeddingResult reports WHICH failure happened', () => {
  afterEach(() => { vi.unstubAllGlobals(); wipe() })

  it('a timeout, a refusal and an empty response give three different answers', async () => {
    const failures: (string | null)[] = []

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError()))
    failures.push((await getEmbeddingResult('timeout case')).failure)

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refusedError()))
    failures.push((await getEmbeddingResult('refused case')).failure)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
    failures.push((await getEmbeddingResult('empty response case')).failure)

    // This is the whole defect in one assertion: today all three are `null`.
    expect(new Set(failures).size).toBe(3)
    expect(failures).toEqual(['timeout', 'connection-refused', 'no-embedding-in-response'])
  })

  it('reports no failure and a vector on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    }))
    const r = await getEmbeddingResult('happy path unique text')
    expect(r.failure).toBeNull()
    expect(r.vector).toBeInstanceOf(Float32Array)
    expect(r.vector?.length).toBe(3)
  })

  it('keeps getEmbedding returning a bare vector-or-null for existing callers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError()))
    expect(await getEmbedding('back-compat unique text')).toBeNull()

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ embedding: [0.5, 0.6] }),
    }))
    const vec = await getEmbedding('back-compat happy unique text')
    expect(vec).toBeInstanceOf(Float32Array)
  })
})

describe('the timeout budget is a parameter, and it is the budget that is enforced', () => {
  afterEach(() => { vi.unstubAllGlobals(); wipe() })

  it('the warm-up budget is larger than the per-row budget', () => {
    // A one-time model load billed to a per-row budget is the defect. If these two
    // are ever equal again, the fix has been undone.
    expect(EMBED_WARMUP_TIMEOUT_MS).toBeGreaterThan(EMBED_TIMEOUT_MS)
  })

  it('aborts at the requested budget, measured on a never-resolving fetch', async () => {
    // Honour the signal the way node's fetch does, so this exercises the real
    // AbortController path rather than a stubbed-out timer.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(abortError()))
      })))
    const started = Date.now()
    const r = await getEmbeddingResult('budget probe unique text', { timeoutMs: 40 })
    const elapsed = Date.now() - started
    expect(r.failure).toBe('timeout')
    expect(elapsed).toBeLessThan(2000)  // it did not sit on the 5s default
  })
})

describe('backfill pays the model load once, not once per row', () => {
  beforeEach(wipe)

  it('gives exactly one call the warm-up budget and the rest the per-row budget', async () => {
    for (let i = 0; i < 4; i++) seedNull(`warmup row ${i}`)
    const budgets: number[] = []
    const embed = vi.fn().mockImplementation(async (_t: string, o: { timeoutMs: number }) => {
      budgets.push(o.timeoutMs)
      return [0.1, 0.2]
    })

    const r = await backfillEmbeddings({ embed })

    expect(r.succeeded).toBe(4)
    expect(budgets.filter((b) => b === EMBED_WARMUP_TIMEOUT_MS)).toHaveLength(1)
    expect(budgets[0]).toBe(EMBED_WARMUP_TIMEOUT_MS)
    expect(budgets.slice(1)).toEqual([EMBED_TIMEOUT_MS, EMBED_TIMEOUT_MS, EMBED_TIMEOUT_MS])
  })

  it('does not spend a warm-up call when there is no work', async () => {
    const embed = vi.fn()
    const r = await backfillEmbeddings({ embed })
    expect(r.total).toBe(0)
    expect(embed).not.toHaveBeenCalled()
  })
})

describe('the run reports an outcome instead of leaving it to be assembled', () => {
  beforeEach(wipe)

  const allFail = () => vi.fn().mockResolvedValue(null)

  it('ok when every row embedded', async () => {
    seedNull('a'); seedNull('b')
    const r = await backfillEmbeddings({ embed: vi.fn().mockResolvedValue([0.1]) })
    expect(r.outcome).toBe('ok')
    expect(r.breakerTripped).toBe(false)
    expect(r.remaining).toBe(0)
  })

  it('ok when there was nothing to do', async () => {
    const r = await backfillEmbeddings({ embed: vi.fn() })
    expect(r.outcome).toBe('ok')
  })

  it('partial when some rows failed but the list was worked through', async () => {
    seedNull('p1'); seedNull('p2'); seedNull('p3'); seedNull('p4')
    // fail, ok, fail, ok -- never three in a row, so the fuse never trips
    const embed = vi.fn()
      .mockResolvedValueOnce(null).mockResolvedValueOnce([0.1])
      .mockResolvedValueOnce(null).mockResolvedValueOnce([0.1])
    const r = await backfillEmbeddings({ embed })
    expect(r.outcome).toBe('partial')
    expect(r.succeeded).toBe(2)
    expect(r.breakerTripped).toBe(false)
    expect(r.aborted).toBe(false)
  })

  it('nothing-embedded when the whole (short) work list failed', async () => {
    seedNull('n1'); seedNull('n2'); seedNull('n3')
    const r = await backfillEmbeddings({ embed: allFail() })
    expect(r.outcome).toBe('nothing-embedded')
    expect(r.succeeded).toBe(0)
    expect(r.breakerTripped).toBe(true)
    // The measured part the old code overstated: nothing was left, so the run did
    // not stop early -- the work simply ran out. `aborted` may not claim otherwise.
    expect(r.remaining).toBe(0)
    expect(r.aborted).toBe(false)
  })

  it('nothing-embedded, and genuinely aborted, when rows were left unattempted', async () => {
    for (let i = 0; i < 5; i++) seedNull(`x${i}`)
    const r = await backfillEmbeddings({ embed: allFail() })
    expect(r.outcome).toBe('nothing-embedded')
    expect(r.failed).toBe(3)
    expect(r.remaining).toBe(2)
    expect(r.aborted).toBe(true)
  })

  it('broken-midway when it embedded rows and then the fuse tripped', async () => {
    for (let i = 0; i < 6; i++) seedNull(`m${i}`)
    const embed = vi.fn()
      .mockResolvedValueOnce([0.1]).mockResolvedValueOnce([0.1])
      .mockResolvedValue(null)
    const r = await backfillEmbeddings({ embed })
    expect(r.outcome).toBe('broken-midway')
    expect(r.succeeded).toBe(2)
    expect(r.breakerTripped).toBe(true)
    expect(r.remaining).toBe(1)
  })

  it('separates the two signals that the 08-07 run could not tell apart', async () => {
    // THE card assertion. On 08-07 the short all-failed run and a genuine mid-run
    // break both surfaced as aborted=true, and the alert quoted the first with the
    // evidence of the second. Same flag, different situations -> different outcome.
    seedNull('s1'); seedNull('s2'); seedNull('s3')
    const short = await backfillEmbeddings({ embed: allFail() })

    wipe()
    for (let i = 0; i < 6; i++) seedNull(`s${i}`)
    const midway = await backfillEmbeddings({
      embed: vi.fn().mockResolvedValueOnce([0.1]).mockResolvedValueOnce([0.1]).mockResolvedValue(null),
    })

    expect(short.outcome).not.toBe(midway.outcome)
    expect(short.outcome).toBe('nothing-embedded')
    expect(midway.outcome).toBe('broken-midway')
  })

  it('counts the failure reasons instead of naming one for all of them', async () => {
    seedNull('r1'); seedNull('r2'); seedNull('r3')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError()))
    try {
      // No embed stub: this runs through the real getEmbedding path, which is where
      // the misleading "Ollama unavailable?" text lived.
      const r = await backfillEmbeddings()
      expect(r.outcome).toBe('nothing-embedded')
      expect(r.failures).toEqual({ timeout: 3 })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('the reembed route quotes the outcome instead of recomputing the gate', () => {
  beforeEach(wipe)
  afterEach(() => vi.unstubAllGlobals())

  /** Drive the real route handler; a mapping asserted only in the test proves nothing. */
  async function postReembed(): Promise<{ status: number; body: Record<string, unknown> }> {
    const req = Readable.from([Buffer.from('{}')]) as unknown as IncomingMessage
    let status = 0
    let payload = ''
    const res = {
      writeHead(s: number) { status = s; return res },
      end(chunk?: string) { payload = chunk ?? '' },
    } as unknown as ServerResponse

    const handled = await tryHandleMemories({
      req, res,
      path: '/api/memories/reembed',
      method: 'POST',
      url: new URL('http://localhost:3420/api/memories/reembed'),
      identity: { agentId: 'dave', scopes: ['*'], source: 'operator' },
    })
    expect(handled).toBe(true)
    return { status, body: JSON.parse(payload) as Record<string, unknown> }
  }

  it('ok=true only when everything embedded', async () => {
    seedNull('route ok 1'); seedNull('route ok 2')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ embedding: [0.1, 0.2] }),
    }))
    const { status, body } = await postReembed()
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.outcome).toBe('ok')
    expect(body.count).toBe(2)  // the dashboard client still reads `count`
  })

  it('ok=false for a short all-failed run, which the old !aborted gate would have called ok', async () => {
    // This is the 08-07 shape: 3 rows, all timing out. The fuse fires exactly as the
    // list runs out, so `aborted` is now false -- and an ok derived from !aborted
    // would have reported a completely failed run as healthy.
    seedNull('route f1'); seedNull('route f2'); seedNull('route f3')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError()))
    const { body } = await postReembed()
    expect(body.aborted).toBe(false)
    expect(body.outcome).toBe('nothing-embedded')
    expect(body.ok).toBe(false)
  })

  it('ok=false when some rows failed but the run finished', async () => {
    seedNull('route p1'); seedNull('route p2')
    const fetchStub = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.1] }) })
      .mockRejectedValueOnce(abortError())
    vi.stubGlobal('fetch', fetchStub)
    const { body } = await postReembed()
    expect(body.outcome).toBe('partial')
    expect(body.ok).toBe(false)
  })
})
