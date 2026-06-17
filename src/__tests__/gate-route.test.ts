import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import { initDatabase } from '../db.js'
import { tryHandleGate, __setGatePrFetcher } from '../web/routes/gate.js'
import type { GithubPrInfo } from '../web/gate-check.js'

const TEST_DB = '/tmp/test-gate-route.db'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

async function call(method: string, fullPath: string, body?: unknown) {
  const url = new URL('http://x' + fullPath)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as never
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(status: number) {
      captured.status = status
      return res
    },
    end(b?: string) {
      captured.body = b ? JSON.parse(b) : undefined
    },
  } as never
  const handled = await tryHandleGate({ req, res, method, path: url.pathname, url } as never)
  return { handled, ...captured }
}

// Default stub: a non-security PR on SHA_A. Individual tests override.
function stubPr(info: Partial<GithubPrInfo> = {}) {
  __setGatePrFetcher(async () => ({ headSha: info.headSha ?? SHA_A, files: info.files ?? ['src/db.ts'] }))
}

beforeEach(() => {
  cleanDb()
  initDatabase(TEST_DB)
  stubPr()
})
afterAll(() => cleanDb())

describe('POST /api/gate/approve (MG-AC1, MG-AC2)', () => {
  it('rejects an invalid reviewer with 400', async () => {
    const r = await call('POST', '/api/gate/approve', { pr_number: 207, head_sha: SHA_A, reviewer: 'alice', verdict: 'approved' })
    expect(r.status).toBe(400)
  })

  it('rejects a truncated head_sha with 400', async () => {
    const r = await call('POST', '/api/gate/approve', { pr_number: 207, head_sha: 'abc123', reviewer: 'dave', verdict: 'approved' })
    expect(r.status).toBe(400)
  })

  it('rejects an invalid verdict and a non-positive pr_number with 400', async () => {
    expect((await call('POST', '/api/gate/approve', { pr_number: 207, head_sha: SHA_A, reviewer: 'dave', verdict: 'meh' })).status).toBe(400)
    expect((await call('POST', '/api/gate/approve', { pr_number: 0, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved' })).status).toBe(400)
  })

  it('inserts a valid approval and returns 201 with a server-stamped recorded_at', async () => {
    const before = Math.floor(Date.now() / 1000)
    const r = await call('POST', '/api/gate/approve', {
      pr_number: 207,
      head_sha: SHA_A,
      reviewer: 'dave',
      verdict: 'approved',
      recorded_by: 'dave',
      recorded_at: 1, // caller value must be IGNORED
    })
    expect(r.status).toBe(201)
    expect(r.body.id).toBeGreaterThan(0)
    expect(r.body.recorded_at).toBeGreaterThanOrEqual(before)
    expect(r.body.recorded_by).toBe('dave')
  })
})

describe('GET /api/gate/check (MG-AC3, MG-AC4, MG-AC6)', () => {
  async function approve(reviewer: string, verdict = 'approved', sha = SHA_A) {
    await call('POST', '/api/gate/approve', { pr_number: 207, head_sha: sha, reviewer, verdict })
  }

  it('400 when pr param is missing or not a positive int', async () => {
    expect((await call('GET', '/api/gate/check')).status).toBe(400)
    expect((await call('GET', '/api/gate/check?pr=0')).status).toBe(400)
    expect((await call('GET', '/api/gate/check?pr=abc')).status).toBe(400)
  })

  it('passes once both required reviewers approved the live sha', async () => {
    await approve('thor')
    await approve('dave')
    const r = await call('GET', '/api/gate/check?pr=207')
    expect(r.status).toBe(200)
    expect(r.body.pass).toBe(true)
    expect(r.body.required).toEqual(['thor', 'dave'])
    expect(r.body.missing).toEqual([])
  })

  it('a security-path PR requires chad', async () => {
    stubPr({ files: ['scripts/hooks/guardrail-x.py'] })
    await approve('thor')
    await approve('dave')
    const r = await call('GET', '/api/gate/check?pr=207')
    expect(r.body.required).toEqual(['thor', 'dave', 'chad'])
    expect(r.body.missing).toEqual(['chad'])
    expect(r.body.pass).toBe(false)
  })

  it('a blocked verdict is sticky and keeps the gate closed (MG-SEC3)', async () => {
    await approve('thor')
    await approve('dave')
    await approve('dave', 'blocked')
    await approve('dave', 'approved') // later approve must NOT clear the block
    const r = await call('GET', '/api/gate/check?pr=207')
    expect(r.body.blocked).toContain('dave')
    expect(r.body.pass).toBe(false)
  })

  it('approvals on an old sha do not count after a new commit (MG-AC6)', async () => {
    await approve('thor', 'approved', SHA_A)
    await approve('dave', 'approved', SHA_A)
    stubPr({ headSha: SHA_B }) // PR got a new commit
    const r = await call('GET', '/api/gate/check?pr=207')
    expect(r.body.head_sha).toBe(SHA_B)
    expect(r.body.pass).toBe(false)
    expect(r.body.missing).toEqual(['thor', 'dave'])
  })

  it('returns 502 if the GitHub fetch fails', async () => {
    __setGatePrFetcher(async () => {
      throw new Error('GitHub PR fetch failed (404)')
    })
    const r = await call('GET', '/api/gate/check?pr=207')
    expect(r.status).toBe(502)
  })
})

describe('override lifecycle over HTTP (MG-AC7)', () => {
  it('override clears the gate, consume re-closes it, consume is idempotent, wrong sha 404s', async () => {
    // No approvals -> gate fails.
    expect((await call('GET', '/api/gate/check?pr=207')).body.pass).toBe(false)

    // Override -> pass with override_active.
    const ov = await call('POST', '/api/gate/override', { pr_number: 207, head_sha: SHA_A, reason: 'prod down, Boss approved' })
    expect(ov.status).toBe(201)
    expect(ov.body.active).toBe(true)
    const checked = await call('GET', '/api/gate/check?pr=207')
    expect(checked.body.pass).toBe(true)
    expect(checked.body.override_active).toBe(true)

    // Consume after a (simulated) successful merge.
    const consumed = await call('POST', '/api/gate/consume-override', { pr_number: 207, head_sha: SHA_A })
    expect(consumed.status).toBe(200)
    expect(consumed.body.consumed).toBe(true)

    // Gate re-closes (original approvals still missing).
    expect((await call('GET', '/api/gate/check?pr=207')).body.pass).toBe(false)

    // Idempotent: second consume still 200.
    expect((await call('POST', '/api/gate/consume-override', { pr_number: 207, head_sha: SHA_A })).status).toBe(200)

    // Wrong sha -> 404.
    expect((await call('POST', '/api/gate/consume-override', { pr_number: 207, head_sha: SHA_B })).status).toBe(404)
  })

  it('override requires a non-empty reason', async () => {
    expect((await call('POST', '/api/gate/override', { pr_number: 207, head_sha: SHA_A, reason: '   ' })).status).toBe(400)
  })
})

describe('append-only enforcement (MG-SEC3)', () => {
  it('DELETE and PATCH on any gate resource return 405', async () => {
    expect((await call('DELETE', '/api/gate/approvals/42')).status).toBe(405)
    expect((await call('PATCH', '/api/gate/approve/42')).status).toBe(405)
  })
})
