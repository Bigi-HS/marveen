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

const daveId: AgentIdentity = { agentId: 'dave', scopes: ['message:send'], source: 'agent' }

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
async function callRaw(method: string, rawBody: string) {
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
    identity: daveId,
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
    const r = await call('POST', { frozen: true })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ frozen: true })
    expect(writer.calls).toEqual([true])
  })

  it('{ frozen: false } clears the freeze and echoes the state', async () => {
    const writer = writerSpy()
    __setReleaseFreezeDeps({ write: writer.fn })
    const r = await call('POST', { frozen: false })
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
    const r = await call('POST', {})
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/frozen/)
    expect(writer.calls).toEqual([])
  })

  it('rejects a non-boolean frozen value with 400 and does NOT mutate state', async () => {
    const writer = writerSpy()
    __setReleaseFreezeDeps({ write: writer.fn })
    const r = await call('POST', { frozen: 'yes' })
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
    const r = await call('POST', { frozen: true })
    expect(r.status).toBe(500)
    expect(r.body.error).toMatch(/freeze state/)
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
