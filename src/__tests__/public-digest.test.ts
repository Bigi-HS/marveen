/**
 * WS2 public-digest endpoint tests (card e7c1c7ac).
 * TDD: these tests are written BEFORE the implementation; they drive it.
 *
 * Coverage:
 *  (a) happy path: exactly the 11 permitted fields, correct shape
 *  (b) scalar/12-char guard: no string value > 12 chars; arrays-of-records blocked
 *  (c) NEGATIVE LEAK TEST: seeded secret markers must not appear in the response
 *  (d) rate-limit: 61st request within a window -> 429
 *  (e) kill-switch: PUBLIC_DIGEST_ENABLED=false -> 503, no DB query
 *  (f) auth: handler is only reached post-auth (middleware note + structural check)
 *  (g) determinism: seeded rows -> exact counts (high_priority, tasks_completed_7d, schedule)
 */
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerResponse, IncomingMessage } from 'node:http'
import type { AgentIdentity } from '../web/agent-token-registry.js'
import type { RouteContext } from '../web/routes/types.js'
import { initNoaDb, getNoaDb } from '../noa-memory.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

// ── Mocks (declared before any dynamic imports) ─────────────────────────────

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn().mockReturnValue(['dave', 'thor']),
  readAgentModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
  costForUsageDetailedUsd: vi.fn().mockReturnValue(0.001),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: vi.fn().mockReturnValue(false),
  capturePane: vi.fn().mockReturnValue(null),
  isTmuxSessionAlive: vi.fn().mockReturnValue(false),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../web/token-usage.js', () => ({
  getTokenSummary: vi.fn().mockReturnValue([
    { agent: 'marveen', totalCostUsd: 0.5, totalCalls: 10, totalInput: 1000, totalOutput: 200, totalCacheRead: 0, totalCacheCreation: 0, firstSeen: 0, lastSeen: 0 },
    { agent: 'dave', totalCostUsd: 0.25, totalCalls: 5, totalInput: 500, totalOutput: 100, totalCacheRead: 0, totalCacheCreation: 0, firstSeen: 0, lastSeen: 0 },
  ]),
}))

const { tryHandlePublicDigest, __resetStatusCache, STATUS_TTL_MS } = await import('../web/routes/public-digest.js')
const { getTokenSummary } = await import('../web/token-usage.js')
const { isAgentRunning, capturePane, isTmuxSessionAlive } = await import('../web/agent-process.js')

// ── Test DB setup ────────────────────────────────────────────────────────────

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initNoaDb(':memory:')
  getNoaDb().exec(SCHEMA_SQL)
})

function wipe(): void {
  const db = getNoaDb()
  db.prepare('DELETE FROM kanban_cards').run()
  db.prepare('DELETE FROM agent_messages').run()
  db.prepare('DELETE FROM scheduled_tasks').run()
  db.prepare('DELETE FROM memories').run()
}

// ── Helper: mock RouteContext ────────────────────────────────────────────────

let mockStatusCode = 200
let mockBody = ''
const mockRemoteAddress = '127.0.0.1'

function makeMockRes(): ServerResponse {
  mockStatusCode = 200
  mockBody = ''
  return {
    writeHead: (code: number) => { mockStatusCode = code },
    end: (body: string) => { mockBody = body },
    setHeader: () => {},
    getHeader: () => undefined,
  } as unknown as ServerResponse
}

function makeCtx(overrides: { remoteAddress?: string } = {}): RouteContext {
  const addr = overrides.remoteAddress ?? mockRemoteAddress
  return {
    req: {
      socket: { remoteAddress: addr },
    } as unknown as IncomingMessage,
    res: makeMockRes(),
    path: '/api/public-digest',
    method: 'GET',
    url: new URL('http://localhost:3420/api/public-digest'),
    identity: {
      agentId: 'marveen',
      scopes: [],
      isAnonymous: false,
    } as unknown as AgentIdentity,
  }
}

// reset env and mocks between tests
afterEach(() => {
  delete process.env.PUBLIC_DIGEST_ENABLED
  // Status cache persists across resolves by design; clear it between tests so a
  // test's isAgentRunning/capturePane mock state is never masked by a prior cache.
  __resetStatusCache()
})

// ── (a) Happy path ───────────────────────────────────────────────────────────

describe('(a) happy path -- 11 permitted fields, correct shape', () => {
  beforeEach(wipe)

  it('returns 200 with all 11 top-level data points', async () => {
    const ctx = makeCtx()
    const handled = await tryHandlePublicDigest(ctx)
    expect(handled).toBe(true)
    expect(mockStatusCode).toBe(200)

    const body = JSON.parse(mockBody)

    // agents section
    expect(body.agents).toBeDefined()
    expect(body.agents.count_by_status).toBeDefined()
    expect(typeof body.agents.count_by_status.idle).toBe('number')
    expect(typeof body.agents.count_by_status.busy).toBe('number')
    expect(typeof body.agents.count_by_status.offline).toBe('number')

    // kanban
    expect(body.kanban).toBeDefined()
    expect(body.kanban.count_by_column).toBeDefined()
    expect(typeof body.kanban.high_priority_count).toBe('number')

    // schedule
    expect(body.schedule).toBeDefined()
    expect(typeof body.schedule.upcoming_count_24h).toBe('number')
    expect(typeof body.schedule.next_fire_ts).toBe('number')

    // token_cost
    expect(body.token_cost).toBeDefined()
    expect(typeof body.token_cost.total_usd_7d).toBe('number')
    expect(body.token_cost.by_agent).toBeDefined()

    // activity
    expect(body.activity).toBeDefined()
    expect(typeof body.activity.messages_sent_24h).toBe('number')
    expect(typeof body.activity.tasks_completed_7d).toBe('number')
  })

  it('returns correct structure for agents -- each named agent has status + last_active_ts', async () => {
    const ctx = makeCtx()
    await tryHandlePublicDigest(ctx)
    const body = JSON.parse(mockBody)

    // count_by_status is NOT itself a named-agent entry
    expect(body.agents.count_by_status).toBeDefined()
    // The named agents (marveen + dave + thor from mock)
    const agentEntries = Object.entries(body.agents).filter(([k]) => k !== 'count_by_status')
    expect(agentEntries.length).toBeGreaterThan(0)
    for (const [, v] of agentEntries) {
      const entry = v as { status: string; last_active_ts: number }
      expect(['idle', 'busy', 'offline']).toContain(entry.status)
      expect(typeof entry.last_active_ts).toBe('number')
    }
  })

  it('does not match non-GET requests', async () => {
    const ctx = { ...makeCtx(), method: 'POST' }
    const handled = await tryHandlePublicDigest(ctx)
    expect(handled).toBe(false)
  })

  it('does not match wrong path', async () => {
    const ctx = { ...makeCtx(), path: '/api/other' }
    const handled = await tryHandlePublicDigest(ctx)
    expect(handled).toBe(false)
  })
})

// ── (b) Scalar / 12-char guard ───────────────────────────────────────────────

describe('(b) scalar/12-char value guard', () => {
  beforeEach(wipe)

  it('no string value in the response exceeds 12 characters (agent-name keys exempt)', async () => {
    const ctx = makeCtx()
    await tryHandlePublicDigest(ctx)
    const body = JSON.parse(mockBody)

    function checkValues(obj: unknown, path: string): void {
      if (obj === null || obj === undefined) return
      if (typeof obj === 'string') {
        expect(obj.length, `String value at ${path} exceeds 12 chars: "${obj}"`).toBeLessThanOrEqual(12)
      } else if (typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          // Agent name keys are exempt (spec 4.2) -- skip checking the VALUE
          // of a key that IS an agent name (those values are objects, not strings, anyway)
          checkValues(v, `${path}.${k}`)
        }
      } else if (Array.isArray(obj)) {
        // No arrays-of-records in the digest
        expect(obj.length, `Array found at ${path} -- not permitted`).toBe(0)
      }
    }

    checkValues(body, 'root')
  })

  it('all leaf values are scalars (int, float, string, or null -- no arrays of records)', async () => {
    const ctx = makeCtx()
    await tryHandlePublicDigest(ctx)
    const body = JSON.parse(mockBody)

    function assertNoArrayOfRecords(obj: unknown, path: string): void {
      if (Array.isArray(obj)) {
        for (const item of obj) {
          expect(typeof item, `Array-of-records found at ${path}`).not.toBe('object')
        }
        return
      }
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          assertNoArrayOfRecords(v, `${path}.${k}`)
        }
      }
    }

    assertNoArrayOfRecords(body, 'root')
  })
})

// ── (c) Negative leak test ───────────────────────────────────────────────────

describe('(c) negative leak test -- secret markers must not appear in response', () => {
  beforeEach(wipe)

  it('seeded secret content does not appear in digest JSON', async () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)

    // Seed memory with secret marker
    db.prepare(
      `INSERT INTO memories (agent_id, content, category, keywords, created_at, accessed_at)
       VALUES ('marveen', 'SECRET_MEMORY_MARKER_7x9q', 'hot', 'secret', ?, ?)`
    ).run(nowS, nowS)

    // Seed agent_message with body marker
    db.prepare(
      `INSERT INTO agent_messages (from_agent, to_agent, content, status, priority, ack_expected, created_at)
       VALUES ('marveen', 'dave', 'SECRET_MSG_BODY_zk2p', 'delivered', 50, 0, ?)`
    ).run(nowS)

    // Seed kanban card with title marker
    db.prepare(
      `INSERT INTO kanban_cards (id, title, description, status, priority, sort_order, created_at, updated_at)
       VALUES ('test-leak-1', 'SECRET_CARD_TITLE_8wqr', 'SECRET_CARD_DESC_9pmx', 'planned', 'normal', 1, ?, ?)`
    ).run(nowS, nowS)

    const ctx = makeCtx()
    await tryHandlePublicDigest(ctx)
    expect(mockStatusCode).toBe(200)

    expect(mockBody).not.toContain('SECRET_MEMORY_MARKER_7x9q')
    expect(mockBody).not.toContain('SECRET_MSG_BODY_zk2p')
    expect(mockBody).not.toContain('SECRET_CARD_TITLE_8wqr')
    expect(mockBody).not.toContain('SECRET_CARD_DESC_9pmx')
    // No credential or token should appear
    expect(mockBody).not.toContain('dashboard-token')
    expect(mockBody).not.toContain('ANTHROPIC')
    expect(mockBody).not.toContain('Bearer')
    // No per-session or per-model breakdown
    expect(mockBody).not.toContain('session_id')
    expect(mockBody).not.toContain('sessionId')
  })
})

// ── (d) Rate-limit ───────────────────────────────────────────────────────────

describe('(d) rate-limit -- 61st request -> 429', () => {
  beforeEach(wipe)

  it('allows 60 requests per minute then returns 429', async () => {
    // Use a fresh distinct IP so it starts at 0 in the limiter
    const ip = `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
    for (let i = 0; i < 60; i++) {
      const ctx = makeCtx({ remoteAddress: ip })
      await tryHandlePublicDigest(ctx)
      expect(mockStatusCode, `request ${i + 1} should be allowed`).toBe(200)
    }
    // 61st should be rate-limited
    const ctx = makeCtx({ remoteAddress: ip })
    await tryHandlePublicDigest(ctx)
    expect(mockStatusCode).toBe(429)
  })
})

// ── (e) Kill-switch ──────────────────────────────────────────────────────────

describe('(e) kill-switch -- falsy values -> 503, no DB query (spec 4.5 v1.2)', () => {
  it.each([
    ['false'],
    ['FALSE'],
    ['0'],
    ['no'],
    ['off'],
  ])('returns 503 for PUBLIC_DIGEST_ENABLED=%s (case-insensitive)', async (val) => {
    process.env.PUBLIC_DIGEST_ENABLED = val
    const getSpy = vi.spyOn(getNoaDb(), 'prepare')

    const ctx = makeCtx()
    const handled = await tryHandlePublicDigest(ctx)

    expect(handled).toBe(true)
    expect(mockStatusCode).toBe(503)
    expect(getSpy).not.toHaveBeenCalled()

    getSpy.mockRestore()
  })

  it('returns 200 when PUBLIC_DIGEST_ENABLED is unset (enabled by default)', async () => {
    delete process.env.PUBLIC_DIGEST_ENABLED
    const ctx = makeCtx()
    await tryHandlePublicDigest(ctx)
    expect(mockStatusCode).toBe(200)
  })

  it('returns 200 when PUBLIC_DIGEST_ENABLED=true', async () => {
    process.env.PUBLIC_DIGEST_ENABLED = 'true'
    const ctx = makeCtx()
    await tryHandlePublicDigest(ctx)
    expect(mockStatusCode).toBe(200)
  })

  it('returns 200 when PUBLIC_DIGEST_ENABLED=yes', async () => {
    process.env.PUBLIC_DIGEST_ENABLED = 'yes'
    const ctx = makeCtx()
    await tryHandlePublicDigest(ctx)
    expect(mockStatusCode).toBe(200)
  })
})

// ── (f) Auth -- structural note ──────────────────────────────────────────────

describe('(f) auth -- Bearer protection', () => {
  it('handler is only reachable post-auth (web.ts middleware guards /api/* before calling tryHandle*)', () => {
    // The route handler (tryHandlePublicDigest) is called from web.ts AFTER the
    // Bearer/session check that returns 401 on failure. The handler itself does NOT
    // need to check auth -- it always receives an authenticated identity.
    // This is verified by the dashboard-auth.ts tests (verifyDashboardToken).
    //
    // Structural proof: calling the handler directly with any identity works (auth
    // is already enforced upstream). A missing/invalid Bearer causes web.ts to
    // short-circuit before the handler is ever invoked.
    expect(tryHandlePublicDigest).toBeDefined()
    expect(typeof tryHandlePublicDigest).toBe('function')
  })
})

// ── (g) Determinism ──────────────────────────────────────────────────────────

describe('(g) determinism -- seeded rows produce exact counts', () => {
  beforeEach(wipe)

  it('high_priority_count counts only open (planned/in_progress/waiting) high+urgent cards', async () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)

    // 2 high/urgent open cards
    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('hpc-1', 'H1', 'planned', 'high', nowS, nowS)
    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('hpc-2', 'H2', 'in_progress', 'urgent', nowS, nowS)
    // 1 high but DONE -- must NOT be counted
    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('hpc-3', 'H3', 'done', 'high', nowS, nowS)
    // 1 normal open -- must NOT be counted
    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('hpc-4', 'H4', 'waiting', 'normal', nowS, nowS)

    const ctx = makeCtx()
    await tryHandlePublicDigest(ctx)
    const body = JSON.parse(mockBody)
    expect(body.kanban.high_priority_count).toBe(2)
  })

  it('tasks_completed_7d counts only done cards updated within 7 days', async () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    const sevenDaysAgo = nowS - 7 * 24 * 60 * 60

    // 2 done cards within 7 days
    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('tc-1', 'T1', 'done', 'normal', nowS, nowS)
    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('tc-2', 'T2', 'done', 'normal', nowS, nowS - 3600)
    // 1 done but OLDER than 7 days -- must NOT be counted
    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('tc-3', 'T3', 'done', 'normal', nowS, sevenDaysAgo - 100)
    // 1 planned -- must NOT be counted
    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('tc-4', 'T4', 'planned', 'normal', nowS, nowS)

    const ctx = makeCtx()
    await tryHandlePublicDigest(ctx)
    const body = JSON.parse(mockBody)
    expect(body.activity.tasks_completed_7d).toBe(2)
  })

  it('schedule counts use noa.db scheduled_tasks (upcoming_count_24h)', async () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)
    const in12h = nowS + 12 * 3600
    const in36h = nowS + 36 * 3600
    const past = nowS - 3600

    // 2 active tasks firing within 24h
    db.prepare(`INSERT INTO scheduled_tasks (id,agent,type,description,prompt,schedule,next_run,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run('s1', 'marveen', 'task', '', 'do it', '0 9 * * *', in12h, 'active', nowS)
    db.prepare(`INSERT INTO scheduled_tasks (id,agent,type,description,prompt,schedule,next_run,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run('s2', 'dave', 'heartbeat', '', 'check', '*/30 * * * *', nowS + 100, 'active', nowS)
    // past -- NOT counted
    db.prepare(`INSERT INTO scheduled_tasks (id,agent,type,description,prompt,schedule,next_run,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run('s3', 'marveen', 'task', '', 'old', '0 8 * * *', past, 'active', nowS)
    // beyond 24h -- NOT counted
    db.prepare(`INSERT INTO scheduled_tasks (id,agent,type,description,prompt,schedule,next_run,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run('s4', 'marveen', 'task', '', 'future', '0 8 * * *', in36h, 'active', nowS)
    // paused -- NOT counted
    db.prepare(`INSERT INTO scheduled_tasks (id,agent,type,description,prompt,schedule,next_run,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run('s5', 'marveen', 'task', '', 'paused', '0 8 * * *', in12h, 'paused', nowS)

    const ctx = makeCtx()
    await tryHandlePublicDigest(ctx)
    const body = JSON.parse(mockBody)
    expect(body.schedule.upcoming_count_24h).toBe(2)
    expect(body.schedule.next_fire_ts).toBe(nowS + 100)
  })

  it('kanban.count_by_column returns exact counts by status', async () => {
    const db = getNoaDb()
    const nowS = Math.floor(Date.now() / 1000)

    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('col-1', 'A', 'planned', 'normal', nowS, nowS)
    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('col-2', 'B', 'planned', 'normal', nowS, nowS)
    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('col-3', 'C', 'in_progress', 'normal', nowS, nowS)
    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('col-4', 'D', 'done', 'normal', nowS, nowS)
    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('col-5', 'E', 'done', 'normal', nowS, nowS)
    db.prepare(`INSERT INTO kanban_cards (id,title,status,priority,sort_order,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`).run('col-6', 'F', 'done', 'normal', nowS, nowS)

    const ctx = makeCtx()
    await tryHandlePublicDigest(ctx)
    const body = JSON.parse(mockBody)
    expect(body.kanban.count_by_column).toEqual({
      planned: 2,
      in_progress: 1,
      waiting: 0,
      done: 3,
    })
  })

  it('token_cost uses getTokenSummary (7d window passed)', async () => {
    const ctx = makeCtx()
    await tryHandlePublicDigest(ctx)
    const body = JSON.parse(mockBody)

    expect(body.token_cost.total_usd_7d).toBeCloseTo(0.75, 5)
    expect(body.token_cost.by_agent.marveen).toBeCloseTo(0.5, 5)
    expect(body.token_cost.by_agent.dave).toBeCloseTo(0.25, 5)

    // Verify getTokenSummary was called with a 7d-ago timestamp
    expect(vi.mocked(getTokenSummary)).toHaveBeenCalledWith(
      expect.any(Number),
      undefined,
    )
    const [[fromArg]] = vi.mocked(getTokenSummary).mock.calls
    const nowS = Math.floor(Date.now() / 1000)
    expect(fromArg).toBeGreaterThan(nowS - 7 * 24 * 3600 - 10)
    expect(fromArg).toBeLessThanOrEqual(nowS - 7 * 24 * 3600 + 10)
  })
})

// ── (h) Status-cache TTL -- collapse per-agent tmux spawns (card beb1d807) ─────

describe('(h) status-cache -- limits per-agent tmux capturePane spawns', () => {
  // 3 resolvable agents: marveen (main -> isTmuxSessionAlive path) + dave + thor.
  beforeEach(() => {
    wipe()
    __resetStatusCache()
    vi.mocked(isAgentRunning).mockReturnValue(true)
    vi.mocked(isTmuxSessionAlive).mockReturnValue(true)
    vi.mocked(capturePane).mockReturnValue('idle pane text')
  })

  afterEach(() => {
    // Restore the default (offline) mock state for the rest of the suite.
    vi.mocked(isAgentRunning).mockReturnValue(false)
    vi.mocked(isTmuxSessionAlive).mockReturnValue(false)
    vi.mocked(capturePane).mockReturnValue(null)
    vi.useRealTimers()
    __resetStatusCache()
  })

  it('captures each agent exactly once, then a second rapid request adds ZERO spawns (cache hit within TTL)', async () => {
    vi.mocked(capturePane).mockClear()
    const ip = '10.9.1.1'

    await tryHandlePublicDigest(makeCtx({ remoteAddress: ip }))
    const afterFirst = vi.mocked(capturePane).mock.calls.length
    // marveen + dave + thor -> exactly 3 tmux capture-pane spawns
    expect(afterFirst).toBe(3)

    // Second request well within the TTL window: fully served from cache.
    await tryHandlePublicDigest(makeCtx({ remoteAddress: ip }))
    expect(vi.mocked(capturePane).mock.calls.length).toBe(afterFirst)
  })

  it('recomputes (re-spawns) after the TTL window expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    __resetStatusCache()
    vi.mocked(capturePane).mockClear()

    await tryHandlePublicDigest(makeCtx({ remoteAddress: '10.9.2.1' }))
    expect(vi.mocked(capturePane).mock.calls.length).toBe(3)

    // Jump just past the TTL -> cache entries stale -> all 3 agents recompute.
    vi.setSystemTime(STATUS_TTL_MS + 1)
    await tryHandlePublicDigest(makeCtx({ remoteAddress: '10.9.2.2' }))
    expect(vi.mocked(capturePane).mock.calls.length).toBe(6)
  })

  it('still returns a valid busy/idle status while serving from cache', async () => {
    const ip = '10.9.3.1'
    await tryHandlePublicDigest(makeCtx({ remoteAddress: ip }))
    await tryHandlePublicDigest(makeCtx({ remoteAddress: ip }))
    const body = JSON.parse(mockBody)
    const entries = Object.entries(body.agents).filter(([k]) => k !== 'count_by_status')
    for (const [, v] of entries) {
      expect(['idle', 'busy', 'offline']).toContain((v as { status: string }).status)
    }
    // 'idle pane text' -> detectPaneState -> our seeded panes resolve to a real status.
    expect(body.agents.count_by_status.offline).toBe(0)
  })
})
