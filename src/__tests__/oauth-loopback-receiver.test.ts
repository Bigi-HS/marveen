import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  LOOPBACK_HOST,
  generateState,
  buildAuthUrl,
  awaitLoopbackCode,
} from '../mcp/google-authorize.js'

// SEC-042 (card 1d2a4fe0, DA-42). The one-time OAuth authorize scripts stood up a
// loopback code receiver with `server.listen(PORT)` -- host-less, so Node bound
// `::` (every interface) and the 5-minute consent window was reachable from the
// LAN -- and the flow carried no `state` nonce, so any party that could reach
// that port could inject its own `?code=`. These pin both halves of the fix on
// the SHARED helper both scripts now call, so the class cannot come back in one
// script while the other is fixed.

describe('awaitLoopbackCode -- host binding', () => {
  it('binds the loopback interface only, never a wildcard address', async () => {
    const state = generateState()
    let resolveInfo!: (i: AddressInfo) => void
    const listening = new Promise<AddressInfo>((r) => {
      resolveInfo = r
    })
    const codeP = awaitLoopbackCode({
      port: 0,
      redirectUri: 'http://localhost/',
      expectedState: state,
      timeoutMs: 5000,
      onListening: resolveInfo,
    })
    const info = await listening
    expect(info.address).toBe('127.0.0.1')
    expect(info.address).not.toBe('::')
    expect(info.address).not.toBe('0.0.0.0')

    await fetch(`http://127.0.0.1:${info.port}/?code=abc&state=${state}`)
    await expect(codeP).resolves.toBe('abc')
  })

  it('exports the loopback host as a named constant (no bare listen(PORT))', () => {
    expect(LOOPBACK_HOST).toBe('127.0.0.1')
  })
})

describe('awaitLoopbackCode -- state nonce', () => {
  async function callReceiver(query: string, expectedState: string): Promise<{
    promise: Promise<string>
    body: string
    status: number
  }> {
    let resolveInfo!: (i: AddressInfo) => void
    const listening = new Promise<AddressInfo>((r) => {
      resolveInfo = r
    })
    const promise = awaitLoopbackCode({
      port: 0,
      redirectUri: 'http://localhost/',
      expectedState,
      timeoutMs: 5000,
      onListening: resolveInfo,
    })
    // Attach a no-op catch immediately so a rejection never surfaces as an
    // unhandled rejection between here and the assertion.
    promise.catch(() => {})
    const info = await listening
    const res = await fetch(`http://127.0.0.1:${info.port}/${query}`)
    return { promise, body: await res.text(), status: res.status }
  }

  it('accepts the code when the state matches', async () => {
    const state = generateState()
    const { promise } = await callReceiver(`?code=good-code&state=${state}`, state)
    await expect(promise).resolves.toBe('good-code')
  })

  it('REJECTS a redirect carrying no state at all, and never yields the code', async () => {
    const state = generateState()
    const { promise, status } = await callReceiver('?code=injected', state)
    await expect(promise).rejects.toThrow(/state/i)
    expect(status).toBe(400)
  })

  it('REJECTS a mismatched state, and never yields the code', async () => {
    const state = generateState()
    const { promise, status } = await callReceiver(
      `?code=injected&state=${generateState()}`,
      state,
    )
    await expect(promise).rejects.toThrow(/state/i)
    expect(status).toBe(400)
  })

  it('still surfaces a genuine provider error once the state checks out', async () => {
    const state = generateState()
    const { promise } = await callReceiver(`?error=access_denied&state=${state}`, state)
    await expect(promise).rejects.toThrow(/access_denied/)
  })

  it('escapes reflected query values instead of echoing them into the page', async () => {
    const state = generateState()
    const { body } = await callReceiver(
      `?error=${encodeURIComponent('<script>alert(1)</script>')}&state=${state}`,
      state,
    )
    expect(body).not.toContain('<script>')
    expect(body).toContain('&lt;script&gt;')
  })
})

describe('generateState', () => {
  it('is a 256-bit hex nonce', () => {
    expect(generateState()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is unpredictable across calls', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateState()))
    expect(seen.size).toBe(50)
  })
})

describe('buildAuthUrl -- state', () => {
  it('carries the state nonce into the consent URL when given', () => {
    const state = generateState()
    const u = new URL(buildAuthUrl('cid', 'http://localhost:4117/', undefined, state))
    expect(u.searchParams.get('state')).toBe(state)
  })

  it('omits state when none is supplied (back-compatible)', () => {
    const u = new URL(buildAuthUrl('cid', 'http://localhost:4117/'))
    expect(u.searchParams.has('state')).toBe(false)
  })
})

// The source-level "nothing binds host-less" invariant is NOT re-implemented
// here. listen-host-guard.test.ts already owns it, already scans src/ AND
// scripts/, and carries the ratchet list this card empties. A second scanner
// with its own weaker regex would be the divergence that lets one go green while
// the other bites. What this file owns instead is the RUNTIME proof above: the
// receiver actually binds 127.0.0.1 and actually refuses a foreign state.
//
// One thing the first draft of this file got wrong, recorded because it is the
// point: the duplicate scanner keyed on `createServer(` in scripts/, and this
// fix REMOVED createServer from both scripts. Its scan set went empty and the
// lint passed over zero files -- green because it measured nothing.
describe('scripts/ authorize flows use the shared receiver', () => {
  const scriptsDir = join(__dirname, '..', '..', 'scripts')
  const authorizeScripts = ['google-oauth-authorize.ts', 'youtube-oauth-authorize.ts']

  it.each(authorizeScripts)('%s delegates to awaitLoopbackCode with a generated state', (name) => {
    const src = readFileSync(join(scriptsDir, name), 'utf-8')
    expect(src).toContain('awaitLoopbackCode(')
    expect(src).toContain('generateState()')
    // No local receiver left behind to drift out of sync with the shared one.
    expect(src).not.toContain('createServer(')
  })
})
