/**
 * Route-integration coverage for the merge-time gate enforcement on
 * POST /api/github/merge (card 194f474c, D-1a: same-final-head invariant).
 *
 * The pure invariant -- "approvals count only on the CURRENT head.sha" -- is
 * already implemented and unit-tested at the runGateCheck level
 * (gate-check.test.ts, MG-AC6). What was NOT covered is the ROUTE that enforces
 * it at merge time: the /api/github/merge branch in tryHandleGithub that returns
 * 403 when a required reviewer is missing/blocked on the live head, and 409 when
 * the caller supplies a stale head_sha. That branch is the load-bearing guard --
 * if a refactor drops it, no existing test would notice. These tests pin it.
 *
 * The critical safety property asserted on EVERY rejected path: the merge runner
 * is never invoked (no merge egress when the gate is not satisfied).
 *
 * Network deps (the live-head PR fetcher + the GitHub merge call) are injected
 * via __setGithubMergeDeps, mirroring gate.ts's __setGatePrFetcher seam, so the
 * route runs fully in-process against a seeded test DB.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'
import { initDatabase, getDb } from '../db.js'
import { tryHandleGithub, __setGithubMergeDeps, __resetGithubMergeDeps } from '../web/routes/github.js'
import { insertApproval, insertOverride, insertCiRun, insertPrAuthor } from '../web/gate-db.js'
import type { GithubPrInfo } from '../web/gate-check.js'
import type { AgentIdentity } from '../web/agent-token-registry.js'

const TEST_DB = '/tmp/test-github-merge-gate-route.db'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const PR = 335

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

const daveId: AgentIdentity = { agentId: 'dave', scopes: ['message:send'], source: 'agent' }

// Seed a reviewer verdict against a specific head_sha in the live test DB.
function seed(reviewer: string, verdict: string, sha: string) {
  insertApproval(getDb(), { pr_number: PR, head_sha: sha, reviewer, verdict, recorded_by: reviewer }, 1000)
}

// A merge runner spy: records every call and returns a canned success.
function mergeSpy() {
  const calls: Array<{ pr: number; headSha: string; mergeMethod: string }> = []
  const fn = vi.fn(async (args: { pr: number; headSha: string; mergeMethod: string }) => {
    calls.push(args)
    return { sha: 'merged00commit00sha00000000000000000000', message: 'Merged' }
  })
  return { fn, calls }
}

// Inject a live-head PR fetcher (headSha + changed files) and a merge runner.
function wire(opts: { liveHead: string; files?: string[]; merge: ReturnType<typeof mergeSpy> }) {
  const fetchPr = async (_pr: number): Promise<GithubPrInfo> => ({
    headSha: opts.liveHead,
    files: opts.files ?? ['src/db.ts'],
  })
  __setGithubMergeDeps({ fetchPr, merge: opts.merge.fn as never })
}

async function callMerge(body: unknown, identity: AgentIdentity = daveId) {
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
    setHeader() {},
  } as never
  const handled = await tryHandleGithub({
    req,
    res,
    method: 'POST',
    path: '/api/github/merge',
    url: new URL('http://x/api/github/merge'),
    identity,
  } as never)
  return { handled, ...captured }
}

beforeEach(() => {
  cleanDb()
  initDatabase(TEST_DB)
})
afterEach(() => {
  __resetGithubMergeDeps()
})
afterAll(() => cleanDb())

describe('POST /api/github/merge -- same-final-head gate enforcement (card 194f474c)', () => {
  it('(a) stale approvals on the old head -> 403 missing, merge NOT called (PR#335 at merge time)', async () => {
    // thor+dave approved SHA_A, but the branch moved to SHA_B (radar must-fix +
    // nits) and nobody re-approved. Exactly the PR#335 shape at merge time.
    seed('thor', 'approved', SHA_A)
    seed('dave', 'approved', SHA_A)
    const merge = mergeSpy()
    wire({ liveHead: SHA_B, merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_B, merge_method: 'merge' })

    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/missing approvals/)
    expect(r.body.gate.missing).toEqual(['thor', 'dave'])
    expect(r.body.gate.head_sha).toBe(SHA_B)
    expect(merge.calls).toHaveLength(0) // no merge egress
  })

  it('(b) approved on live head but caller supplies a stale head_sha -> 409, merge NOT called', async () => {
    // Reviewers re-approved on the live head SHA_B, but the caller's merge request
    // still carries the stale SHA_A -> the 40-char SHA guard must 409, not merge.
    seed('thor', 'approved', SHA_B)
    seed('dave', 'approved', SHA_B)
    const merge = mergeSpy()
    wire({ liveHead: SHA_B, merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_A, merge_method: 'merge' })

    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/head SHA mismatch/i)
    expect(r.body.live_head_sha).toBe(SHA_B)
    expect(merge.calls).toHaveLength(0)
  })

  it('(c) a blocked verdict on the live head -> 403, merge NOT called', async () => {
    seed('thor', 'approved', SHA_A)
    seed('dave', 'blocked', SHA_A)
    const merge = mergeSpy()
    wire({ liveHead: SHA_A, merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_A, merge_method: 'merge' })

    expect(r.status).toBe(403)
    expect(r.body.gate.blocked).toContain('dave')
    expect(r.body.gate.pass).toBe(false)
    expect(merge.calls).toHaveLength(0)
  })

  it('(d) security-sensitive PR missing chad -> 403, merge NOT called', async () => {
    // A hooks/ change requires chad; thor+dave alone must not clear the gate.
    seed('thor', 'approved', SHA_A)
    seed('dave', 'approved', SHA_A)
    const merge = mergeSpy()
    wire({ liveHead: SHA_A, files: ['scripts/hooks/guardrail-x.py'], merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_A, merge_method: 'merge' })

    expect(r.status).toBe(403)
    expect(r.body.gate.required).toEqual(['thor', 'dave', 'chad'])
    expect(r.body.gate.missing).toEqual(['chad'])
    expect(merge.calls).toHaveLength(0)
  })

  it('(e) all required seats approved on the live head + matching sha -> merges once, 200', async () => {
    seed('thor', 'approved', SHA_A)
    seed('dave', 'approved', SHA_A)
    const merge = mergeSpy()
    wire({ liveHead: SHA_A, merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_A, merge_method: 'merge' })

    expect(r.status).toBe(200)
    expect(r.body.merged).toBe(true)
    expect(merge.calls).toHaveLength(1)
    expect(merge.calls[0]).toMatchObject({ pr: PR, headSha: SHA_A, mergeMethod: 'merge' })
  })

  it('(f) a Boss override on the live head clears an otherwise-missing gate -> merges', async () => {
    // No approvals at all, but an active override for (PR, live head) forces pass.
    insertOverride(getDb(), { pr_number: PR, head_sha: SHA_A, reason: 'boss emergency', recorded_by: 'marveen' }, 1000)
    const merge = mergeSpy()
    wire({ liveHead: SHA_A, merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_A, merge_method: 'merge' })

    expect(r.status).toBe(200)
    expect(merge.calls).toHaveLength(1)
  })

  it('(g) an override bound to the OLD head does NOT clear the gate on the new head -> 403', async () => {
    // Override was granted for SHA_A; the branch then moved to SHA_B. The override
    // must not leak across the head change (same-head discipline applies to it too).
    insertOverride(getDb(), { pr_number: PR, head_sha: SHA_A, reason: 'boss emergency', recorded_by: 'marveen' }, 1000)
    const merge = mergeSpy()
    wire({ liveHead: SHA_B, merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_B, merge_method: 'merge' })

    expect(r.status).toBe(403)
    expect(r.body.gate.override_active).toBe(false)
    expect(merge.calls).toHaveLength(0)
  })
})

// Card 46de122b: the merge route applies author recusal. A reviewer who authored
// the PR cannot fill their own seat (MG-SEC5), so hard-requiring them deadlocked
// the merge (PR#417). With a recorded author, that reviewer is dropped from
// `required` and the backup (chad) is promoted, unblocking the author-recused
// merge -- while never letting a security PR pass without a security seat.
describe('POST /api/github/merge -- author recusal (card 46de122b)', () => {
  const seedAuthor = (agent: string) => insertPrAuthor(getDb(), PR, agent, 900)

  it('(h) dave-authored non-security PR: thor+chad approved -> merges (dave recused, chad promoted)', async () => {
    // Exactly PR#417: dave cannot self-approve, so before recusal required=[thor,dave]
    // deadlocked at 403. Now dave is recused and chad's approval fills the promoted seat.
    seedAuthor('dave')
    seed('thor', 'approved', SHA_A)
    seed('chad', 'approved', SHA_A)
    const merge = mergeSpy()
    wire({ liveHead: SHA_A, merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_A, merge_method: 'merge' })

    expect(r.status).toBe(200)
    expect(r.body.merged).toBe(true)
    expect(merge.calls).toHaveLength(1)
  })

  it('(i) dave-authored non-security PR with only thor -> 403 missing chad, merge NOT called', async () => {
    seedAuthor('dave')
    seed('thor', 'approved', SHA_A)
    const merge = mergeSpy()
    wire({ liveHead: SHA_A, merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_A, merge_method: 'merge' })

    expect(r.status).toBe(403)
    expect(r.body.gate.required).toEqual(['thor', 'chad'])
    expect(r.body.gate.recused).toEqual(['dave'])
    expect(r.body.gate.missing).toEqual(['chad'])
    expect(merge.calls).toHaveLength(0)
  })

  it('(j) chad-authored SECURITY PR: thor+dave approved must NOT pass (security seat unfilled)', async () => {
    // Red-team attack #2: recusing chad on a security PR would strip the only
    // security review. chad stays required -> missing -> 403, no merge egress.
    seedAuthor('chad')
    seed('thor', 'approved', SHA_A)
    seed('dave', 'approved', SHA_A)
    const merge = mergeSpy()
    wire({ liveHead: SHA_A, files: ['scripts/hooks/guardrail-x.py'], merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_A, merge_method: 'merge' })

    expect(r.status).toBe(403)
    expect(r.body.gate.required).toEqual(['thor', 'dave', 'chad'])
    expect(r.body.gate.missing).toEqual(['chad'])
    expect(merge.calls).toHaveLength(0)
  })
})

// Card 0c166e48: the merge route inherits the independent-CI requirement via
// runGateCheck. With GATE_CI_REQUIRED on, an all-seats-approved PR still cannot
// merge until a fresh Buster-CI PASS exists on the live head -- the strongest
// point of enforcement (merge time, not just the advisory check endpoint).
describe('POST /api/github/merge -- independent CI enforcement (card 0c166e48)', () => {
  let savedFlag: string | undefined
  beforeEach(() => {
    savedFlag = process.env.GATE_CI_REQUIRED
    process.env.GATE_CI_REQUIRED = '1'
  })
  afterEach(() => {
    if (savedFlag === undefined) delete process.env.GATE_CI_REQUIRED
    else process.env.GATE_CI_REQUIRED = savedFlag
  })

  const postCi = (sha: string, status: string) =>
    insertCiRun(getDb(), { pr_number: PR, head_sha: sha, status, recorded_by: 'buster' }, 1500)

  it('flag ON: all seats approved but NO CI bundle -> 403, merge NOT called', async () => {
    seed('thor', 'approved', SHA_A)
    seed('dave', 'approved', SHA_A)
    const merge = mergeSpy()
    wire({ liveHead: SHA_A, merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_A, merge_method: 'merge' })

    expect(r.status).toBe(403)
    expect(r.body.gate.ci_required).toBe(true)
    expect(r.body.gate.ci_status).toBe('none')
    expect(merge.calls).toHaveLength(0)
  })

  it('flag ON: seats approved + Buster CI PASS on the live head -> merges once', async () => {
    seed('thor', 'approved', SHA_A)
    seed('dave', 'approved', SHA_A)
    postCi(SHA_A, 'pass')
    const merge = mergeSpy()
    wire({ liveHead: SHA_A, merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_A, merge_method: 'merge' })

    expect(r.status).toBe(200)
    expect(merge.calls).toHaveLength(1)
  })

  it('flag ON: CI PASS bound to the OLD head does NOT clear the moved head -> 403', async () => {
    // Approvals + CI on SHA_A, but the branch moved to SHA_B (nothing re-run).
    seed('thor', 'approved', SHA_B)
    seed('dave', 'approved', SHA_B)
    postCi(SHA_A, 'pass') // stale CI, bound to the old sha
    const merge = mergeSpy()
    wire({ liveHead: SHA_B, merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_B, merge_method: 'merge' })

    expect(r.status).toBe(403)
    expect(r.body.gate.ci_status).toBe('none') // stale bundle not counted on the live head
    expect(merge.calls).toHaveLength(0)
  })

  it('flag ON: a Buster CI FAIL on the live head blocks the merge -> 403', async () => {
    seed('thor', 'approved', SHA_A)
    seed('dave', 'approved', SHA_A)
    postCi(SHA_A, 'fail')
    const merge = mergeSpy()
    wire({ liveHead: SHA_A, merge })

    const r = await callMerge({ pr_number: PR, head_sha: SHA_A, merge_method: 'merge' })

    expect(r.status).toBe(403)
    expect(r.body.gate.ci_status).toBe('fail')
    expect(merge.calls).toHaveLength(0)
  })
})
