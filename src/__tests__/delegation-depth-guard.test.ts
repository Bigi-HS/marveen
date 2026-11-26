// Inter-agent delegation loop/depth guard (card 3e80e203, DA G-02) falsifying tests.
//
// The DA mandate (spec §3) is that each test MEASURES THE DANGEROUS SIDE -- a
// runaway cycle must STOP -- not just the happy path. The four tests:
//   1. self-loop          -- a chain that delegates toward its own origin STOPS
//                            after N hops (the N-th insert is declined, 429).
//   2. root-depth-0        -- a root (no parent) message inserts with depth 0.
//   3. non-spoofable       -- a client that supplies a LOW delegation_depth on a
//                            deep parent chain is OVERRIDDEN by the server-derived
//                            depth; the guard still fires (proves server derivation).
//   4. legit-deep-chain    -- a legitimate chain just UNDER the limit passes
//                            through (no false-positive decline).
//
// The route is exercised directly (same harness idiom as messages-guard-persist),
// against a temp DB. The Boss-escalation delivery is replaced with a spy seam so no
// real Telegram message is ever sent.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// Accept any non-empty recipient without filesystem access (same as the
// messages-guard-persist harness).
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...actual, normalizeRecipient: (to: string) => (to?.trim() ? to.trim() : null), isKnownAgent: () => true }
})

import { initDatabase, getDb, getAgentMessage } from '../db.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { DELEGATION_DEPTH_LIMIT } from '../config.js'
import { _setDelegationEscalateDeliver } from '../web/delegation-depth-guard.js'

const TEST_DB = '/tmp/test-delegation-depth-guard.db'

// Spy escalation seam: records each Boss-escalation call instead of hitting Telegram.
let escalations: string[] = []
let restoreDeliver: (() => void) | null = null

beforeEach(() => {
  rmSync(TEST_DB, { force: true })
  initDatabase(TEST_DB)
  escalations = []
  const prev = _setDelegationEscalateDeliver(async (text: string) => { escalations.push(text) })
  restoreDeliver = () => { _setDelegationEscalateDeliver(prev) }
})
afterEach(() => { restoreDeliver?.() })
afterAll(() => rmSync(TEST_DB, { force: true }))

type PostOverrides = { delegation_parent_id?: number; delegation_depth?: number }

/** Build + invoke a POST /api/messages ctx. Returns the captured response. */
async function post(from: string, to: string, content: string, extra: PostOverrides = {}) {
  const body = JSON.stringify({ from, to, content, ...extra })
  const req = Readable.from([Buffer.from(body)]) as any
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(s: number) { captured.status = s; return res },
    end(b?: string) {
      try { captured.body = b ? JSON.parse(b) : undefined } catch { captured.body = b }
    },
  } as any
  const url = new URL('http://x/api/messages')
  const identity = { agentId: from, scopes: ['admin:*'] } // admin passes the from-binding
  const ctx = { req, res, method: 'POST', path: '/api/messages', url, identity } as any
  await tryHandleMessages(ctx)
  return captured
}

/**
 * Drive a self-referential delegation chain hop by hop: each message is sent with
 * delegation_parent_id = the previous accepted message's id, so the server-derived
 * depth climbs 0,1,2,... exactly as a real NoA->Armorer->NoA cycle would. Returns
 * the sequence of captured responses.
 */
async function driveChain(hops: number) {
  const results: Array<{ status: number; body: any; id?: number }> = []
  let parentId: number | undefined = undefined
  for (let i = 0; i < hops; i++) {
    const r = await post('marveen', 'marveen', `delegate hop ${i}`, { delegation_parent_id: parentId })
    const entry = { status: r.status, body: r.body, id: r.body?.id as number | undefined }
    results.push(entry)
    if (r.status === 200 && entry.id) parentId = entry.id
    else break // chain halted (declined)
  }
  return results
}

// ── 1. self-loop: the chain STOPS after N hops ───────────────────────────────

describe('self-loop chain stops at the depth limit (AC3/AC5, DANGEROUS side)', () => {
  it('declines the message that would reach delegation_depth === limit, and escalates once', async () => {
    // Drive limit+2 hops; the first `limit` (depths 0..limit-1) insert, the next
    // one derives depth === limit and must be declined.
    const results = await driveChain(DELEGATION_DEPTH_LIMIT + 2)

    // Exactly `limit` messages inserted (depths 0 .. limit-1).
    const accepted = results.filter(r => r.status === 200)
    expect(accepted.length).toBe(DELEGATION_DEPTH_LIMIT)
    accepted.forEach((r, i) => {
      expect(r.body.delegation_depth).toBe(i)
      expect(getAgentMessage(r.id!)!.delegation_depth).toBe(i)
    })

    // The next hop is declined with the structured error at depth === limit.
    const declined = results.find(r => r.status === 429)
    expect(declined).toBeDefined()
    expect(declined!.body.error).toBe('delegation_depth_exceeded')
    expect(declined!.body.depth).toBe(DELEGATION_DEPTH_LIMIT)
    expect(declined!.body.limit).toBe(DELEGATION_DEPTH_LIMIT)

    // The declined message was NOT inserted.
    const total = (getDb().prepare('SELECT COUNT(*) AS c FROM agent_messages').get() as { c: number }).c
    expect(total).toBe(DELEGATION_DEPTH_LIMIT)

    // Boss escalated exactly once (alert-false-alarm-audit: only the real limit hit).
    expect(escalations.length).toBe(1)
    expect(escalations[0]).toContain('Delegation depth limit reached')
  })
})

// ── 2. root-depth-0: a root inserts with depth 0 ─────────────────────────────

describe('root message inserts with delegation_depth 0 (AC1/AC5)', () => {
  it('a message with no parent is a root (depth 0, parent NULL) and does not escalate', async () => {
    const r = await post('dominik', 'marveen', 'Boss-initiated root task')
    expect(r.status).toBe(200)
    expect(r.body.delegation_depth).toBe(0)
    expect(r.body.delegation_parent_id).toBeNull()
    const row = getAgentMessage(r.body.id)!
    expect(row.delegation_depth).toBe(0)
    expect(row.delegation_parent_id).toBeNull()
    expect(escalations.length).toBe(0)
  })
})

// ── 3. non-spoofable: client depth is overridden by server derivation ────────

describe('client-supplied delegation_depth is non-spoofable (AC2, anti-spoofing)', () => {
  it('a deep parent chain declines even when the client claims delegation_depth=0', async () => {
    // Build a legit chain up to depth limit-1 (the last accepted message).
    const chain = await driveChain(DELEGATION_DEPTH_LIMIT)
    const accepted = chain.filter(r => r.status === 200)
    expect(accepted.length).toBe(DELEGATION_DEPTH_LIMIT)
    const deepParentId = accepted[accepted.length - 1].id! // depth limit-1

    // The attacker sends the next hop off that deep parent but LIES depth=0.
    const r = await post('marveen', 'marveen', 'spoof shallow', {
      delegation_parent_id: deepParentId,
      delegation_depth: 0, // ignored by the server
    })

    // Server derives limit (parentDepth+1) regardless of the client claim -> declined.
    expect(r.status).toBe(429)
    expect(r.body.error).toBe('delegation_depth_exceeded')
    expect(r.body.depth).toBe(DELEGATION_DEPTH_LIMIT)
    expect(escalations.length).toBe(1)
  })

  it('a root message does not inherit a spoofed-high client depth (server derives 0)', async () => {
    // The inverse: a client claiming a huge depth on a ROOT must NOT be trusted
    // to inflate the stored value (depth is server-derived, not client-trusted).
    const r = await post('dominik', 'marveen', 'root but client claims deep', { delegation_depth: 999 })
    expect(r.status).toBe(200)
    expect(r.body.delegation_depth).toBe(0)
    expect(getAgentMessage(r.body.id)!.delegation_depth).toBe(0)
  })
})

// ── 4. legit-deep-chain: just under the limit passes through ─────────────────

describe('legitimate deep chain under the limit passes (AC5, no false-positive)', () => {
  it('a chain of exactly limit hops (depths 0..limit-1) all insert, none escalate', async () => {
    const results = await driveChain(DELEGATION_DEPTH_LIMIT)
    expect(results.every(r => r.status === 200)).toBe(true)
    expect(results.length).toBe(DELEGATION_DEPTH_LIMIT)
    // Depths climb 0..limit-1; the deepest legit message is limit-1, NOT declined.
    expect(results[results.length - 1].body.delegation_depth).toBe(DELEGATION_DEPTH_LIMIT - 1)
    expect(escalations.length).toBe(0)
  })
})
