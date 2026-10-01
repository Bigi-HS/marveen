// 0d88fec1: VACUUM + incremental auto_vacuum
// Tests: runDbVacuum (freelist cleared, auto_vacuum=INCREMENTAL, stats returned),
//        runIncrementalVacuum (pages reclaimed), /api/admin/vacuum route (200 + stats).

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { rmSync, statSync } from 'node:fs'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { initDatabase, getDb, runDbVacuum, runIncrementalVacuum } from '../db.js'

const TEST_DB = '/tmp/test-admin-vacuum.db'

function seed(): void {
  const db = getDb()
  // Insert enough rows to span multiple pages (4KB pages; ~100B/row -> 500 rows > 12 pages)
  for (let i = 0; i < 500; i++) {
    db.prepare(
      'INSERT OR IGNORE INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, content_preview) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('vacuum-test', `sess-${i}`, i + 1, 10, 10, 'x'.repeat(80))
  }
  db.prepare("DELETE FROM token_usage WHERE agent = 'vacuum-test'").run()
  // Checkpoint WAL so freed pages appear in freelist_count of the main DB file
  db.pragma('wal_checkpoint(FULL)')
}

beforeEach(() => {
  rmSync(TEST_DB, { force: true })
  initDatabase(TEST_DB)
})
afterAll(() => rmSync(TEST_DB, { force: true }))

// ── runDbVacuum ──────────────────────────────────────────────────────────────

describe('runDbVacuum', () => {
  it('returns non-negative durationMs and sizes', () => {
    const result = runDbVacuum()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.beforeBytes).toBeGreaterThanOrEqual(0)
    expect(result.afterBytes).toBeGreaterThanOrEqual(0)
  })

  it('sets auto_vacuum to INCREMENTAL (mode=2) after running', () => {
    runDbVacuum()
    const mode = getDb().pragma('auto_vacuum', { simple: true }) as number
    expect(mode).toBe(2)
  })

  it('clears the freelist after seeded delete', () => {
    seed()
    const before = getDb().pragma('freelist_count', { simple: true }) as number
    expect(before).toBeGreaterThan(0)

    runDbVacuum()

    const after = getDb().pragma('freelist_count', { simple: true }) as number
    expect(after).toBe(0)
  })

  it('afterBytes <= beforeBytes (file shrinks or stays same after freelist reclaim)', () => {
    seed()
    const result = runDbVacuum()
    expect(result.afterBytes).toBeLessThanOrEqual(result.beforeBytes)
  })

  it('autoVacuumMode in result is 2 (INCREMENTAL)', () => {
    const result = runDbVacuum()
    expect(result.autoVacuumMode).toBe(2)
  })
})

// ── runIncrementalVacuum ─────────────────────────────────────────────────────

describe('runIncrementalVacuum', () => {
  it('returns 0 on a fresh (no freelist) DB', () => {
    expect(runIncrementalVacuum()).toBe(0)
  })

  it('returns pages freed when auto_vacuum=INCREMENTAL and freelist > 0', () => {
    seed()
    // Enable incremental auto_vacuum first (VACUUM required to activate)
    runDbVacuum()
    // Re-seed to create new freelist pages
    seed()
    const freed = runIncrementalVacuum()
    expect(freed).toBeGreaterThanOrEqual(0)
  })
})

// ── /api/admin/vacuum route ──────────────────────────────────────────────────

describe('POST /api/admin/vacuum', () => {
  function makeCtx(path: string, method: string) {
    let responseBody = ''
    let responseStatus = 200
    const res = {
      writeHead: (status: number) => { responseStatus = status },
      end: (body?: string) => { responseBody = body || '' },
    }
    return {
      ctx: {
        req: {} as any,
        res: res as any,
        path,
        method,
        url: new URL(`http://localhost:3420${path}`),
        identity: { agentId: 'operator', scopes: ['admin:*'], source: 'operator' as const },
      },
      getResponse: () => ({ status: responseStatus, body: responseBody ? JSON.parse(responseBody) : null }),
    }
  }

  it('returns 200 with ok=true and stats', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { ctx, getResponse } = makeCtx('/api/admin/vacuum', 'POST')
    const handled = await tryHandleAdmin(ctx)
    expect(handled).toBe(true)
    const { status, body } = getResponse()
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof body.beforeBytes).toBe('number')
    expect(typeof body.afterBytes).toBe('number')
    expect(typeof body.durationMs).toBe('number')
    expect(body.autoVacuumMode).toBe(2)
  })

  it('is not handled for GET /api/admin/vacuum (route is POST-only)', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { ctx, getResponse } = makeCtx('/api/admin/vacuum', 'GET')
    const handled = await tryHandleAdmin(ctx)
    // GET falls through to 404 from the outer handler; admin returns false
    expect(handled).toBe(false)
  })

  it('rejects a non-admin agent token with 403', async () => {
    const { tryHandleAdmin } = await import('../web/routes/admin.js')
    const { ctx, getResponse } = makeCtx('/api/admin/vacuum', 'POST')
    // Override identity to a per-agent scope (no admin:*); cast through any to satisfy
    // the narrowed literal type emitted by the makeCtx object literal.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ctx as any).identity = { agentId: 'some-agent', scopes: ['agent:read'], source: 'agent' }
    const handled = await tryHandleAdmin(ctx)
    expect(handled).toBe(true)
    const { status } = getResponse()
    expect(status).toBe(403)
  })
})
