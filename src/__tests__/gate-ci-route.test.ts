/**
 * Route-integration coverage for the independent pre-gate CI (card 0c166e48).
 *
 * POST /api/gate/ci lets Buster post an independent (pr, head_sha)-scoped CI
 * bundle. The load-bearing security property: the bundle is IDENTITY-BOUND --
 * only Buster's own token (or an admin/operator relay) may post, so a PR author
 * cannot forge their own CI PASS. This is the core of the independent-verify
 * weakness the card closes.
 *
 * Also pins the merge-gate wiring: with GATE_CI_REQUIRED on, /api/gate/check
 * refuses to pass until a fresh CI PASS exists on the live head, and clears once
 * Buster posts it -- proving the check route actually consumes gate_ci_runs.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import { initDatabase, getDb } from '../db.js'
import { tryHandleGate, __setGatePrFetcher } from '../web/routes/gate.js'
import { insertApproval, readLatestCiRun } from '../web/gate-db.js'
import type { GithubPrInfo } from '../web/gate-check.js'
import { ADMIN_SCOPE, type AgentIdentity } from '../web/agent-token-registry.js'

const TEST_DB = '/tmp/test-gate-ci-route.db'
const SHA_A = 'a'.repeat(40)
const PR = 700

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

async function call(method: string, fullPath: string, body?: unknown, identity?: AgentIdentity) {
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
  const handled = await tryHandleGate({ req, res, method, path: url.pathname, url, identity } as never)
  return { handled, ...captured }
}

const busterId: AgentIdentity = { agentId: 'buster', scopes: ['message:send'], source: 'agent' }
const daveId: AgentIdentity = { agentId: 'dave', scopes: ['message:send'], source: 'agent' }
const operatorId: AgentIdentity = { agentId: 'marveen', scopes: [ADMIN_SCOPE], source: 'operator' }

function stubPr(info: Partial<GithubPrInfo> = {}) {
  __setGatePrFetcher(async () => ({ headSha: info.headSha ?? SHA_A, files: info.files ?? ['src/db.ts'] }))
}

const ciBody = (over: Record<string, unknown> = {}) => ({
  pr_number: PR,
  head_sha: SHA_A,
  status: 'pass',
  tsc_ok: 1,
  tests_pass: 3511,
  tests_fail: 0,
  diff_files: 2,
  insertions: 221,
  deletions: 3,
  ...over,
})

let savedFlag: string | undefined
beforeEach(() => {
  cleanDb()
  initDatabase(TEST_DB)
  stubPr()
  savedFlag = process.env.GATE_CI_REQUIRED
  delete process.env.GATE_CI_REQUIRED // default OFF
})
afterEach(() => {
  if (savedFlag === undefined) delete process.env.GATE_CI_REQUIRED
  else process.env.GATE_CI_REQUIRED = savedFlag
})
afterAll(() => cleanDb())

describe('POST /api/gate/ci -- identity-bound CI bundle post (card 0c166e48)', () => {
  it('accepts a valid Buster post -> 201 and persists the run', async () => {
    const r = await call('POST', '/api/gate/ci', ciBody(), busterId)
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ pr_number: PR, head_sha: SHA_A, status: 'pass', recorded_by: 'buster' })
    const latest = readLatestCiRun(getDb(), PR, SHA_A)
    expect(latest?.status).toBe('pass')
    expect(latest?.tests_pass).toBe(3511)
  })

  it('REJECTS a non-buster per-agent token -> 403, nothing persisted (author cannot forge a PASS)', async () => {
    const r = await call('POST', '/api/gate/ci', ciBody(), daveId)
    expect(r.status).toBe(403)
    expect(readLatestCiRun(getDb(), PR, SHA_A)).toBeNull()
  })

  it('allows an admin/operator relay to post on Buster behalf -> 201', async () => {
    const r = await call('POST', '/api/gate/ci', ciBody(), operatorId)
    expect(r.status).toBe(201)
    expect(readLatestCiRun(getDb(), PR, SHA_A)?.status).toBe('pass')
  })

  it('treats an absent identity (unauthed unit call) as admin -> 201', async () => {
    const r = await call('POST', '/api/gate/ci', ciBody())
    expect(r.status).toBe(201)
  })

  it('validates head_sha, status and pr_number -> 400', async () => {
    expect((await call('POST', '/api/gate/ci', ciBody({ head_sha: 'abc123' }), busterId)).status).toBe(400)
    expect((await call('POST', '/api/gate/ci', ciBody({ status: 'maybe' }), busterId)).status).toBe(400)
    expect((await call('POST', '/api/gate/ci', ciBody({ pr_number: 0 }), busterId)).status).toBe(400)
  })

  it('is append-only: DELETE /api/gate/ci -> 405', async () => {
    const r = await call('DELETE', '/api/gate/ci', undefined, busterId)
    expect(r.status).toBe(405)
  })
})

describe('merge-gate wiring: /api/gate/check consumes CI when GATE_CI_REQUIRED (card 0c166e48)', () => {
  it('flag ON: reviewers approved but no CI bundle -> pass=false, ci_required=true, ci_status=none; clears after Buster posts PASS', async () => {
    process.env.GATE_CI_REQUIRED = '1'
    insertApproval(getDb(), { pr_number: PR, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1000)
    insertApproval(getDb(), { pr_number: PR, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, 1000)

    const before = await call('GET', `/api/gate/check?pr=${PR}`)
    expect(before.status).toBe(200)
    expect(before.body.pass).toBe(false)
    expect(before.body.ci_required).toBe(true)
    expect(before.body.ci_status).toBe('none')
    expect(before.body.missing).toEqual([]) // seats present; block is CI

    await call('POST', '/api/gate/ci', ciBody(), busterId)

    const after = await call('GET', `/api/gate/check?pr=${PR}`)
    expect(after.body.pass).toBe(true)
    expect(after.body.ci_status).toBe('pass')
    expect(after.body.ci_pass).toBe(true)
  })

  it('flag OFF (default): missing CI is reported but does not block the gate', async () => {
    insertApproval(getDb(), { pr_number: PR, head_sha: SHA_A, reviewer: 'thor', verdict: 'approved', recorded_by: 'thor' }, 1000)
    insertApproval(getDb(), { pr_number: PR, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', recorded_by: 'dave' }, 1000)

    const r = await call('GET', `/api/gate/check?pr=${PR}`)
    expect(r.body.pass).toBe(true)
    expect(r.body.ci_required).toBe(false)
    expect(r.body.ci_status).toBe('none')
  })
})
