// Tests for GET /api/messages unknown-param guard (card d30c17e0).
// Verifies that unrecognized query params return 400 and that valid
// params continue to return 200.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync } from 'node:fs'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// Accept any non-empty recipient without hitting the filesystem.
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    normalizeRecipient: (to: string) => (to?.trim() ? to.trim() : null),
    isKnownAgent: () => true,
  }
})

import { initDatabase } from '../db.js'
import { tryHandleMessages } from '../web/routes/messages.js'

const TEST_DB = '/tmp/test-messages-route.db'

function cleanDb() {
  for (const s of ['', '-wal', '-shm']) rmSync(TEST_DB + s, { force: true })
}

beforeEach(() => {
  cleanDb()
  initDatabase(TEST_DB)
})
afterAll(() => cleanDb())

function call(queryString: string) {
  const fullPath = '/api/messages' + (queryString ? '?' + queryString : '')
  const url = new URL('http://x' + fullPath)
  const req = Readable.from([]) as any
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(s: number) { captured.status = s; return res },
    end(b?: string) {
      try { captured.body = b ? JSON.parse(b) : undefined }
      catch { captured.body = b }
    },
  } as any
  // admin:* scope so from-binding checks pass for unrelated POST tests that
  // may share the module; GET ignores identity, but it must be present in ctx.
  const identity = { agentId: 'dave', scopes: ['admin:*'] }
  const ctx = { req, res, method: 'GET', path: '/api/messages', url, identity } as any
  return tryHandleMessages(ctx).then(() => captured)
}

// ── d30c17e0: unknown param → 400 ────────────────────────────────────────────

describe('GET /api/messages unknown-param guard (card d30c17e0)', () => {
  it('unknown param returns 400 with descriptive error', async () => {
    const r = await call('unknown=x')
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/Unknown filter param/)
    expect(r.body.error).toContain('unknown')
  })

  it('valid param agent= returns 200 (guard does not block valid params)', async () => {
    const r = await call('agent=dave')
    expect(r.status).toBe(200)
  })

  it('mixed valid+unknown params returns 400 on the unknown one', async () => {
    const r = await call('status=pending&typo=1')
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/Unknown filter param/)
  })
})
