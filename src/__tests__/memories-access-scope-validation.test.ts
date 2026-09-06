// Card 97ed2d2c: access_scope field must be null or an existing agent_id.
//
// The defect: the server accepted any string as access_scope and stored it.
// applyScopeFilter then matched by exact agent_id equality, so a category name
// like 'shared' or 'private' used as access_scope produced a row that was
// invisible to the owner (scope='shared' never equals any agent_id).
//
// Fix direction: validate at write time -- reject any non-null access_scope that
// is not a known agent_id (per listAgentNames() + MAIN_AGENT_ID). The error
// message must name the category field as the correct way to set visibility tier.

import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../noa-memory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../noa-memory.js')>()
  return {
    ...actual,
    saveAgentMemory: vi.fn(() => ({ id: 99, access_scope: null })),
    getNoaDb: vi.fn(() => ({ prepare: vi.fn(() => ({ get: vi.fn(() => undefined) })) })),
  }
})

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['dave', 'thor', 'marveen', 'rackham', 'chad'],
  isKnownAgent: (name: string) => ['dave', 'thor', 'marveen', 'rackham', 'chad'].includes(name),
  AGENTS_BASE_DIR: '/tmp/agents',
}))

vi.mock('../web/guard-event-recorder.js', () => ({
  recordGuardEvent: vi.fn(),
}))

import { tryHandleMemories } from '../web/routes/memories.js'

function fakePostCtx(body: Record<string, unknown>) {
  const raw = JSON.stringify(body)
  const req = Readable.from([Buffer.from(raw)]) as any
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(s: number) { captured.status = s; return res },
    end(b?: string) {
      try { captured.body = b ? JSON.parse(b) : undefined }
      catch { captured.body = b }
    },
  } as any
  const url = new URL('http://x/api/memories')
  const ctx = { req, res, method: 'POST', path: '/api/memories', url, identity: null } as any
  return { ctx, captured }
}

describe('POST /api/memories -- access_scope validation (card 97ed2d2c)', () => {
  it('rejects a category name used as access_scope with 400', async () => {
    const { ctx, captured } = fakePostCtx({ agent_id: 'marveen', content: 'test', category: 'warm', access_scope: 'shared' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(400)
    expect(captured.body.error).toMatch(/access_scope/)
    expect(captured.body.error).toMatch(/category/)
  })

  it('rejects "private" (not an agent_id) with 400', async () => {
    const { ctx, captured } = fakePostCtx({ agent_id: 'marveen', content: 'test', category: 'warm', access_scope: 'private' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(400)
    expect(captured.body.error).toMatch(/access_scope/)
  })

  it('rejects an arbitrary unknown string with 400', async () => {
    const { ctx, captured } = fakePostCtx({ agent_id: 'marveen', content: 'test', category: 'warm', access_scope: 'foobar-unknown' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(400)
  })

  it('accepts a known agent_id as access_scope', async () => {
    const { ctx, captured } = fakePostCtx({ agent_id: 'marveen', content: 'test', category: 'warm', access_scope: 'dave' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(200)
    expect(captured.body.ok).toBe(true)
  })

  it('accepts access_scope=null (explicit opt-out)', async () => {
    const { ctx, captured } = fakePostCtx({ agent_id: 'marveen', content: 'test', category: 'warm', access_scope: null })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(200)
  })

  it('accepts absent access_scope (PII auto-scope path)', async () => {
    const { ctx, captured } = fakePostCtx({ agent_id: 'marveen', content: 'test', category: 'warm' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(200)
  })
})
