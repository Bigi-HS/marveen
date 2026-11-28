/**
 * Route coverage for the planning-freeze HTTP API (card 2efcb439, slice 4c-3).
 *
 *   GET  /api/release/planning-freeze            -> { frozen: boolean }
 *   POST /api/release/planning-freeze {frozen}   -> { frozen: boolean }
 *
 * This is the AUTHORITATIVE server freeze-API required by Inv-8: the fix-window
 * job (§6) and the deploy gate (§7) consult it first, with
 * store/planning-freeze.enabled as the file fallback. The endpoint reads/writes
 * that SAME flag through planning-freeze.ts, so there is ONE freeze contract.
 *
 * The load-bearing safety property asserted on EVERY rejected POST path: the
 * freeze WRITER is never invoked when the request is malformed or invalid (no
 * silent state mutation from a bad body) -- mirrors the "merge runner never
 * invoked when the gate is not satisfied" invariant in github-merge-gate-route.
 *
 * SEC F-03 scope enforcement (card 16c34f11): POST is operator-only. Any
 * per-agent token (source:'agent') receives 403 and the writer is never called.
 * The pattern mirrors gate.ts (identity.source !== 'operator' check).
 *
 * Read/write deps are injected via __setReleaseFreezeDeps so the branches run
 * fully in-process without touching the real store/ flag file.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import {
  tryHandleReleaseFreeze,
  __setReleaseFreezeDeps,
  __resetReleaseFreezeDeps,
} from '../web/routes/release-freeze.js'
import type { AgentIdentity } from '../web/agent-token-registry.js'
import { ADMIN_SCOPE } from '../web/agent-token-registry.js'

const daveId: AgentIdentity = { agentId: 'dave', scopes: ['message:send'], source: 'agent' }
const operatorId: AgentIdentity = { agentId: 'marveen', scopes: [ADMIN_SCOPE], source: 'operator' }

// A writer spy: records every (enabled) call so tests can assert it is NOT
// invoked on rejected paths, and WITH the right value on accepted ones.
function writerSpy() {
  const calls: boolean[] = []
  const fn = vi.fn((enabled: boolean) => {
    calls.push(enabled)
  })
  return { fn, calls }
}

async function call(
  method: string,
  body: unknown,
  opts: { path?: string; identity?: AgentIdentity } = {},
) {
  const path = opts.path ?? '/api/release/planning-freeze'
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
  const handled = await tryHandleReleaseFreeze({
    req,
    res,
    method,
    path,
    url: new URL('http://x' + path),
    identity: opts.identity ?? daveId,
  } as never)
  return { handled, ...captured }
}

// Raw-body variant for the malformed-JSON case (bypasses JSON.stringify).
// Uses operatorId by default so the body-parsing path is actually exercised
// (agent identity is rejected before parsing; scope tests use the call() helper).
async function callRaw(method: string, rawBody: string, identity: AgentIdentity = operatorId) {
  const path = '/api/release/planning-freeze'
  const req = Readable.from([Buffer.from(rawBody)]) as never
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
  const handled = await tryHandleReleaseFreeze({
    req,
    res,
    method,
    path,
    url: new URL('http://x' + path),
    identity,
  } as never)
  return { handled, ...captured }
}

afterEach(() => {
  __resetReleaseFreezeDeps()
})

describe('GET /api/release/planning-freeze -- authoritative read (Inv-8)', () => {
  it('returns { frozen: false } when no freeze is active', async () => {
    __setReleaseFreezeDeps({ read: () => false })
    const r = await call('GET', undefined)
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ frozen: false })
  })

  it('returns { frozen: true } when a freeze is active', async () => {
    __setReleaseFreezeDeps({ read: () => true })
    const r = await call('GET', undefined)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ frozen: true })
  })

  it('never invokes the writer on a read', async () => {
    const writer = writerSpy()
    __setReleaseFreezeDeps({ read: () => true, write: writer.fn })
    await call('GET', undefined)
    expect(writer.calls).toEqual([])
  })

  it('returns 500 (fail-visible) when the reader throws -- no silent green', async () => {
    __setReleaseFreezeDeps({
      read: () => {
        throw new Error('fs boom')
      },
    })
    const r = await call('GET', undefined)
    expect(r.status).toBe(500)
    expect(r.body.error).toMatch(/freeze state/)
  })
})

describe('POST /api/release/planning-freeze -- operator set/clear', () => {
  it('{ frozen: true } enables the freeze and echoes the state', async () => {
    const writer = writerSpy()
    __setReleaseFreezeDeps({ write: writer.fn })
    const r = await call('POST', { frozen: true }, { identity: operatorId })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ frozen: true })
    expect(writer.calls).toEqual([true])
  })

  it('{ frozen: false } clears the freeze and echoes the state', async () => {
    const writer = writerSpy()
    __setReleaseFreezeDeps({ write: writer.fn })
    const r = await call('POST', { frozen: false }, { identity: operatorId })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ frozen: false })
    expect(writer.calls).toEqual([false])
  })

  it('rejects a malformed JSON body with 400 and does NOT mutate state', async () => {
    const writer = writerSpy()
    __setReleaseFreezeDeps({ write: writer.fn })
    const r = await callRaw('POST', '{not json')
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/body/)
    expect(writer.calls).toEqual([])
  })

  it('rejects a missing frozen field with 400 and does NOT mutate state', async () => {
    const writer = writerSpy()
    __setReleaseFreezeDeps({ write: writer.fn })
    const r = await call('POST', {}, { identity: operatorId })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/frozen/)
    expect(writer.calls).toEqual([])
  })

  it('rejects a non-boolean frozen value with 400 and does NOT mutate state', async () => {
    const writer = writerSpy()
    __setReleaseFreezeDeps({ write: writer.fn })
    const r = await call('POST', { frozen: 'yes' }, { identity: operatorId })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/frozen/)
    expect(writer.calls).toEqual([])
  })

  it('returns 500 when the writer throws -- state change surfaced, not swallowed', async () => {
    __setReleaseFreezeDeps({
      write: () => {
        throw new Error('disk full')
      },
    })
    const r = await call('POST', { frozen: true }, { identity: operatorId })
    expect(r.status).toBe(500)
    expect(r.body.error).toMatch(/freeze state/)
  })
})

describe('POST /api/release/planning-freeze -- scope enforcement (SEC F-03 / card 16c34f11)', () => {
  it('rejects a per-agent token (source:agent) with 403 and never calls the writer', async () => {
    const writer = writerSpy()
    __setReleaseFreezeDeps({ write: writer.fn })
    const r = await call('POST', { frozen: true }, { identity: daveId })
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/operator/)
    expect(writer.calls).toEqual([])
  })

  it('rejects agent-token freeze-clear (frozen:false) with 403 and never calls the writer', async () => {
    const writer = writerSpy()
    __setReleaseFreezeDeps({ write: writer.fn })
    const r = await call('POST', { frozen: false }, { identity: daveId })
    expect(r.status).toBe(403)
    expect(writer.calls).toEqual([])
  })

  it('allows an operator token (source:operator) to set the freeze', async () => {
    const writer = writerSpy()
    __setReleaseFreezeDeps({ write: writer.fn })
    const r = await call('POST', { frozen: true }, { identity: operatorId })
    expect(r.status).toBe(200)
    expect(writer.calls).toEqual([true])
  })

  it('GET is identity-agnostic: agent tokens can read freeze state', async () => {
    __setReleaseFreezeDeps({ read: () => true })
    const r = await call('GET', undefined, { identity: daveId })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ frozen: true })
  })
})

describe('tryHandleReleaseFreeze -- dispatch contract', () => {
  it('returns false (not handled) for an unrelated path so the dispatcher falls through', async () => {
    const writer = writerSpy()
    __setReleaseFreezeDeps({ write: writer.fn })
    const r = await call('GET', undefined, { path: '/api/github/pr' })
    expect(r.handled).toBe(false)
    expect(writer.calls).toEqual([])
  })

  it('returns 405 for an unsupported method on the freeze path', async () => {
    const writer = writerSpy()
    __setReleaseFreezeDeps({ write: writer.fn })
    const r = await call('PUT', { frozen: true })
    expect(r.handled).toBe(true)
    expect(r.status).toBe(405)
    expect(writer.calls).toEqual([])
  })
})
