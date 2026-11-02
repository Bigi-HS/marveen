// SEC: from-binding admin-scope gate on the two remaining control-plane routes
// that were protected ONLY by the shared dashboard bearer (card 109e3c4d):
//   - POST /api/agents/:name/{nudge,run-skill,interrupt}  (agent-actions.ts)
//   - POST /api/autonomy                                   (autonomy.ts)
// Both inject into / mutate privileged state; the shared bearer is readable by
// every sub-agent, so "holds a valid token" is a forgeable actor. The gate uses
// the strict fail-CLOSED shape hasScope(identity?.scopes, ADMIN_SCOPE).
// These are the falsification tests named in the card: they assert the DANGEROUS
// direction (a non-admin token must be DENIED and must NOT reach the sink).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

// Spyable action sinks: the whole point is to prove a denied caller never fires
// injectToAgent / interruptAgent (spy-count 0). vi.hoisted so the spies exist
// before the hoisted vi.mock factory runs.
const { injectToAgent, interruptAgent } = vi.hoisted(() => ({
  injectToAgent: vi.fn(() => 'fired'),
  interruptAgent: vi.fn(() => 'fired'),
}))
vi.mock('../web/action-trigger.js', () => ({
  injectToAgent,
  interruptAgent,
  composeNudgePrompt: (t: string) => t,
  composeSkillPrompt: (s: string) => s,
  isValidSkillName: () => true,
}))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['dave', 'scout', 'buster'],
}))

import { tryHandleAgentActions } from '../web/routes/agent-actions.js'
import { tryHandleAutonomy } from '../web/routes/autonomy.js'

// Build a fake RouteContext. scopes === null -> no identity (unauthenticated);
// otherwise an identity with the given agentId + scopes. bodyObj is streamed as
// the request body for POST handlers that read it.
function fakeCtx(
  method: string,
  fullPath: string,
  opts: { scopes?: string[] | null; agentId?: string; bodyObj?: unknown } = {},
) {
  const url = new URL('http://x' + fullPath)
  const captured: { status: number; body: any } = { status: 200, body: undefined }
  const res = {
    writeHead(status: number) { captured.status = status; return res },
    end(b?: string) { captured.body = b ? JSON.parse(b) : undefined },
  } as any
  const payload = opts.bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(opts.bodyObj))]
  const req = Readable.from(payload) as any
  const identity =
    opts.scopes === null || opts.scopes === undefined && !('scopes' in opts)
      ? undefined
      : opts.scopes === null
        ? undefined
        : { agentId: opts.agentId ?? 'marveen', scopes: opts.scopes }
  const ctx = { req, res, method, path: url.pathname, url, identity } as any
  return { ctx, captured }
}

beforeEach(() => { injectToAgent.mockClear(); interruptAgent.mockClear() })

describe('agent-actions -- admin-scope gate (card 109e3c4d)', () => {
  it('scout per-agent token -> POST /nudge dave is 403 and never injects', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/agents/dave/nudge', { scopes: ['agent:read'], agentId: 'scout', bodyObj: { text: 'hi' } })
    const handled = await tryHandleAgentActions(ctx)
    expect(handled).toBe(true)
    expect(captured.status).toBe(403)
    expect(injectToAgent).toHaveBeenCalledTimes(0)
  })

  it('unauthenticated (no identity) -> POST /nudge is 403 and never injects', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/agents/dave/nudge', { scopes: null, bodyObj: { text: 'hi' } })
    const handled = await tryHandleAgentActions(ctx)
    expect(handled).toBe(true)
    expect(captured.status).toBe(403)
    expect(injectToAgent).toHaveBeenCalledTimes(0)
  })

  it('dave self-drive with a non-admin token -> POST /nudge dave is 403 (token agentId == target does NOT grant)', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/agents/dave/nudge', { scopes: ['agent:read'], agentId: 'dave', bodyObj: { text: 'go' } })
    const handled = await tryHandleAgentActions(ctx)
    expect(captured.status).toBe(403)
    expect(injectToAgent).toHaveBeenCalledTimes(0)
  })

  it('corrupt/empty scope set -> 403 (default-deny)', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/agents/dave/nudge', { scopes: [], agentId: 'scout', bodyObj: { text: 'hi' } })
    const handled = await tryHandleAgentActions(ctx)
    expect(captured.status).toBe(403)
    expect(injectToAgent).toHaveBeenCalledTimes(0)
  })

  it('existence-oracle: scope check precedes the 404, so unknown agent also returns 403 (no leak)', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/agents/ghost-nonexistent/nudge', { scopes: ['agent:read'], agentId: 'scout', bodyObj: { text: 'hi' } })
    await tryHandleAgentActions(ctx)
    expect(captured.status).toBe(403) // NOT 404 -- a non-admin cannot probe which agents exist
  })

  it('interrupt is gated too: non-admin -> 403 and never interrupts', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/agents/dave/interrupt', { scopes: ['agent:read'], agentId: 'scout' })
    await tryHandleAgentActions(ctx)
    expect(captured.status).toBe(403)
    expect(interruptAgent).toHaveBeenCalledTimes(0)
  })

  it('run-skill is gated too: non-admin -> 403 and never injects', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/agents/dave/run-skill', { scopes: ['agent:read'], agentId: 'scout', bodyObj: { skill: 'fleet-ops' } })
    await tryHandleAgentActions(ctx)
    expect(captured.status).toBe(403)
    expect(injectToAgent).toHaveBeenCalledTimes(0)
  })

  it('operator admin:* token -> POST /nudge dave passes the gate and injects once (200)', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/agents/dave/nudge', { scopes: ['admin:*'], agentId: 'marveen', bodyObj: { text: 'status?' } })
    const handled = await tryHandleAgentActions(ctx)
    expect(handled).toBe(true)
    expect(captured.status).toBe(200)
    expect(injectToAgent).toHaveBeenCalledTimes(1)
  })
})

describe('autonomy -- admin-scope gate (card 109e3c4d)', () => {
  it('buster per-agent token -> POST /api/autonomy is 403', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/autonomy', { scopes: ['agent:read'], agentId: 'buster', bodyObj: { key: 'deploy', level: 3 } })
    const handled = await tryHandleAutonomy(ctx)
    expect(handled).toBe(true)
    expect(captured.status).toBe(403)
  })

  it('unauthenticated (no identity) -> POST /api/autonomy is 403', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/autonomy', { scopes: null, bodyObj: { key: 'deploy', level: 3 } })
    await tryHandleAutonomy(ctx)
    expect(captured.status).toBe(403)
  })

  it('corrupt/empty scope set -> 403 (default-deny)', async () => {
    const { ctx, captured } = fakeCtx('POST', '/api/autonomy', { scopes: [], agentId: 'buster', bodyObj: { key: 'deploy', level: 3 } })
    await tryHandleAutonomy(ctx)
    expect(captured.status).toBe(403)
  })

  it('operator admin:* passes the scope gate (reaches body validation -> 400 on bad level, NOT 403)', async () => {
    // level 99 is rejected by the existing 1..3 validation that lives AFTER the
    // gate. Getting a 400 (not 403) proves the admin token cleared the gate
    // without mutating config (saveConfig is never reached on a 400).
    const { ctx, captured } = fakeCtx('POST', '/api/autonomy', { scopes: ['admin:*'], agentId: 'marveen', bodyObj: { key: 'deploy', level: 99 } })
    await tryHandleAutonomy(ctx)
    expect(captured.status).toBe(400)
  })

  it('GET /api/autonomy stays open to any authed token (read is not gated)', async () => {
    const { ctx, captured } = fakeCtx('GET', '/api/autonomy', { scopes: ['agent:read'], agentId: 'scout' })
    const handled = await tryHandleAutonomy(ctx)
    expect(handled).toBe(true)
    // 200 if the real config loads, 404 if the file is absent in this env -- either
    // way NOT 403: the read path must never be scope-blocked.
    expect(captured.status).not.toBe(403)
  })
})
