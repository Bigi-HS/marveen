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
//
// Card 18097d83 (follow-up): also reject non-string non-null values (CHANGE #2),
// and extend PATCH /api/memories/:id to accept access_scope (Q3).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../noa-memory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../noa-memory.js')>()
  return {
    ...actual,
    saveAgentMemory: vi.fn(() => ({ id: 99, access_scope: null })),
    patchMemory: vi.fn((id: number) => id === 999 ? [] : ['access_scope']),
    // memoryOwner (local fn in routes/memories) calls getNoaDb().prepare().get(id).
    // Return a valid owner row so PATCH tests reach patchMemory.
    getNoaDb: vi.fn(() => ({
      prepare: vi.fn(() => ({ get: vi.fn(() => ({ agent_id: 'marveen' })) })),
    })),
  }
})

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['dave', 'thor', 'marveen', 'rackham', 'chad'],
  isKnownAgent: (name: string) => ['dave', 'thor', 'marveen', 'rackham', 'chad', 'marveen'].includes(name),
  AGENTS_BASE_DIR: '/tmp/agents',
}))

vi.mock('../web/guard-event-recorder.js', () => ({
  recordGuardEvent: vi.fn(),
}))

vi.mock('../agent-identity-binding.js', () => ({
  decideMemoryMutation: vi.fn(() => ({ ok: true })),
  enforceFromBindingEnabled: vi.fn(() => false),
}))

import { tryHandleMemories } from '../web/routes/memories.js'
import * as noaMem from '../noa-memory.js'

function fakeCtx(method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>, identity: unknown = null) {
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
  const url = new URL(`http://x${path}`)
  return { ctx: { req, res, method, path, url, identity } as any, captured }
}

beforeEach(() => {
  vi.mocked(noaMem.saveAgentMemory).mockReturnValue({ id: 99, access_scope: null } as any)
  vi.mocked(noaMem.patchMemory).mockImplementation((id: number) => id === 999 ? [] : ['access_scope'])
  vi.mocked(noaMem.getNoaDb).mockReturnValue({
    prepare: vi.fn(() => ({ get: vi.fn(() => ({ agent_id: 'marveen' })) })),
  } as any)
})

describe('POST /api/memories -- access_scope validation (card 97ed2d2c)', () => {
  it('rejects a category name used as access_scope with 400', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/memories', { agent_id: 'marveen', content: 'test', category: 'warm', access_scope: 'shared' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(400)
    expect(captured.body.error).toMatch(/access_scope/)
    expect(captured.body.error).toMatch(/category/)
  })

  it('rejects "private" (not an agent_id) with 400', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/memories', { agent_id: 'marveen', content: 'test', category: 'warm', access_scope: 'private' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(400)
    expect(captured.body.error).toMatch(/access_scope/)
  })

  it('rejects an arbitrary unknown string with 400', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/memories', { agent_id: 'marveen', content: 'test', category: 'warm', access_scope: 'foobar-unknown' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(400)
  })

  it('accepts a known agent_id as access_scope', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/memories', { agent_id: 'marveen', content: 'test', category: 'warm', access_scope: 'dave' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(200)
    expect(captured.body.ok).toBe(true)
  })

  it('accepts access_scope=null (explicit opt-out)', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/memories', { agent_id: 'marveen', content: 'test', category: 'warm', access_scope: null })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(200)
  })

  it('accepts absent access_scope (PII auto-scope path)', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/memories', { agent_id: 'marveen', content: 'test', category: 'warm' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(200)
  })

  // CHANGE #2 (card 18097d83): non-string non-null types must 400, not silently pass.
  it('rejects access_scope: 123 (number) with 400', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/memories', { agent_id: 'marveen', content: 'test', category: 'warm', access_scope: 123 })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(400)
    expect(captured.body.error).toMatch(/access_scope/)
  })

  it('rejects access_scope: {} (object) with 400', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/memories', { agent_id: 'marveen', content: 'test', category: 'warm', access_scope: {} })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(400)
  })

  it('rejects access_scope: "" (empty string) with 400', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/memories', { agent_id: 'marveen', content: 'test', category: 'warm', access_scope: '' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(400)
  })
})

describe('PATCH /api/memories/:id -- access_scope field (card 18097d83 Q3)', () => {
  it('accepts access_scope: known agent_id and patches it', async () => {
    const { ctx, captured } = fakeCtx('PATCH', '/api/memories/1', { access_scope: 'dave' }, { agentId: 'marveen' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(200)
    expect(captured.body.ok).toBe(true)
  })

  it('accepts access_scope: null (clear scope)', async () => {
    const { ctx, captured } = fakeCtx('PATCH', '/api/memories/1', { access_scope: null }, { agentId: 'marveen' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(200)
    expect(captured.body.ok).toBe(true)
  })

  it('rejects access_scope: unknown string with 400', async () => {
    const { ctx, captured } = fakeCtx('PATCH', '/api/memories/1', { access_scope: 'foobar-unknown' }, { agentId: 'marveen' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(400)
    expect(captured.body.error).toMatch(/access_scope/)
  })

  it('rejects access_scope: 123 (number) with 400', async () => {
    const { ctx, captured } = fakeCtx('PATCH', '/api/memories/1', { access_scope: 123 }, { agentId: 'marveen' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(400)
  })

  it('PATCH with no fields returns 400 listing access_scope as valid field', async () => {
    const { ctx, captured } = fakeCtx('PATCH', '/api/memories/1', {}, { agentId: 'marveen' })
    await tryHandleMemories(ctx)
    expect(captured.status).toBe(400)
    expect(captured.body.error).toMatch(/access_scope/)
  })
})
