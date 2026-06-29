import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import { initDatabase } from '../db.js'
import { subscribeDashboardEvents, type DashboardEvent } from '../event-bus.js'
import { tryHandleGate, __setGatePrFetcher } from '../web/routes/gate.js'
import { insertPrAuthor } from '../web/gate-db.js'
import { getDb } from '../db.js'
import type { GithubPrInfo } from '../web/gate-check.js'
import { ADMIN_SCOPE, type AgentIdentity } from '../web/agent-token-registry.js'

const TEST_DB = '/tmp/test-gate-route.db'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

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

// Identities for MG-SEC4 reviewer-binding tests.
const thorId: AgentIdentity = { agentId: 'thor', scopes: ['message:send'], source: 'agent' }
const daveId: AgentIdentity = { agentId: 'dave', scopes: ['message:send'], source: 'agent' }
const chadId: AgentIdentity = { agentId: 'chad', scopes: ['message:send'], source: 'agent' }
const operatorId: AgentIdentity = { agentId: 'marveen', scopes: [ADMIN_SCOPE], source: 'operator' }
const marveenAgentToken: AgentIdentity = { agentId: 'marveen', scopes: [ADMIN_SCOPE], source: 'agent' }

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

describe('reviewer identity binding (MG-SEC4 BLOCK, card db9bc192)', () => {
  const approve = (reviewer: string, identity?: AgentIdentity) =>
    call('POST', '/api/gate/approve', { pr_number: 207, head_sha: SHA_A, reviewer, verdict: 'approved' }, identity)

  it('per-agent token can approve as itself', async () => {
    expect((await approve('thor', thorId)).status).toBe(201)
    expect((await approve('dave', daveId)).status).toBe(201)
    expect((await approve('chad', chadId)).status).toBe(201)
  })

  it('per-agent token cannot approve as a different reviewer (403)', async () => {
    const r = await approve('thor', daveId)  // dave-token claiming to be thor
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/dave.*thor|token identity/)
  })

  it('per-agent token cannot self-approve as all three reviewers', async () => {
    // A compromised dave token must not be able to fill all three seats.
    expect((await approve('thor', daveId)).status).toBe(403)
    expect((await approve('chad', daveId)).status).toBe(403)
  })

  it('operator/admin token can relay any reviewer (NoA author-deferral relay)', async () => {
    expect((await approve('thor', operatorId)).status).toBe(201)
    expect((await approve('dave', operatorId)).status).toBe(201)
    expect((await approve('chad', operatorId)).status).toBe(201)
  })

  it('per-agent token with ADMIN_SCOPE (marveen own token) can relay (admin scope wins)', async () => {
    // marveen's per-agent token carries ADMIN_SCOPE -> relay allowed even with source='agent'.
    expect((await approve('dave', marveenAgentToken)).status).toBe(201)
  })

  it('no identity (test call without auth middleware) treated as admin/relay', async () => {
    // Existing tests call without identity -> MG-SEC4 check is skipped -> backward compatible.
    expect((await approve('dave')).status).toBe(201)
  })
})

describe('POST /api/gate/approve -- MG-SEC5: self-approval block', () => {
  const PR = 250

  function approve(reviewer: string, identity?: AgentIdentity) {
    return call('POST', '/api/gate/approve', { pr_number: PR, head_sha: SHA_A, reviewer, verdict: 'approved' }, identity)
  }

  beforeEach(() => {
    // Record dave as the PR author
    insertPrAuthor(getDb(), PR, 'dave', 1750000000)
  })

  it('blocks dave from approving his own PR (MG-SEC5)', async () => {
    const r = await approve('dave', daveId)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/self.approval|author/)
  })

  it('allows thor to approve a dave-authored PR (different agent)', async () => {
    const r = await approve('thor', thorId)
    expect(r.status).toBe(201)
  })

  it('operator/admin can relay dave-seat for a dave-authored PR (author-deferral)', async () => {
    const r = await approve('dave', operatorId)
    expect(r.status).toBe(201)
  })

  it('self-approval block skipped when author is unknown (no record -> fail-open)', async () => {
    // PR 9999 has no author record -> no block
    const r = await call('POST', '/api/gate/approve', { pr_number: 9999, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved' }, daveId)
    expect(r.status).toBe(201)
  })
})

// F1 realtime (card 513b8fd6): a recorded approval broadcasts a thin-notify
// 'gate' event so the dashboard refreshes the gate panel live. ID-ONLY -- the
// frame carries pr_number + verdict action, NEVER the note/sha/reviewer content
// (Trap-2 egress posture: the SSE is a refetch trigger, not a content channel).
describe('POST /api/gate/approve emits a thin-notify gate event (F1, card 513b8fd6)', () => {
  let seen: DashboardEvent[]
  let off: () => void
  beforeEach(() => {
    seen = []
    off = subscribeDashboardEvents((e) => seen.push(e))
  })
  afterEach(() => off())

  it('a successful approval emits exactly one gate event keyed by pr_number', async () => {
    const r = await call('POST', '/api/gate/approve', {
      pr_number: 207, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved', note: 'looks good',
    })
    expect(r.status).toBe(201)
    const gateEvents = seen.filter((e) => e.type === 'gate')
    expect(gateEvents).toHaveLength(1)
    expect(gateEvents[0]).toEqual({ type: 'gate', id: '207', action: 'approved' })
  })

  it('the frame carries NO content (no note/sha/reviewer) -- egress-safe', async () => {
    await call('POST', '/api/gate/approve', {
      pr_number: 208, head_sha: SHA_B, reviewer: 'chad', verdict: 'blocked', note: 'secret detail',
    })
    const gate = seen.find((e) => e.type === 'gate')!
    const serialized = JSON.stringify(gate)
    expect(serialized).not.toContain('secret detail')
    expect(serialized).not.toContain(SHA_B)
    expect(serialized).not.toContain('chad')
    // Only the three thin-notify keys exist.
    expect(Object.keys(gate).sort()).toEqual(['action', 'id', 'type'])
  })

  it('a rejected (400) approval emits NO gate event', async () => {
    const r = await call('POST', '/api/gate/approve', { pr_number: 0, head_sha: SHA_A, reviewer: 'dave', verdict: 'approved' })
    expect(r.status).toBe(400)
    expect(seen.filter((e) => e.type === 'gate')).toHaveLength(0)
  })
})
