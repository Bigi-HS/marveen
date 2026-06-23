// Schedule-runner integration decision tests for the token-outage direct-send
// bypass (card 92f07145, spec store/spec-direct-send-layer.md DoD section 6).
//
// The runner is tightly coupled to tmux/DB so, as with the skipIfBusy tests, we
// cover the pure routing decision (shouldDirectSend) and the state reader here.
// The three DoD integration scenarios map onto shouldDirectSend:
//   (a) NOT limited + directSend=true  -> normal tmux path (false)
//   (b) limited     + directSend=true  -> direct-send.py (true)
//   (c) limited     + directSend=false -> normal tmux path (false)

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldDirectSend, readTokenOutageState } from '../web/schedule-runner.js'

const limited = { limited: true }
const healthy = { limited: false }

describe('shouldDirectSend (AC-1 trigger, DoD integration scenarios)', () => {
  it('(b) limited + directSend=true -> fires direct-send', () => {
    expect(shouldDirectSend({ directSend: true }, limited)).toBe(true)
  })

  it('(a) NOT limited + directSend=true -> normal path', () => {
    expect(shouldDirectSend({ directSend: true }, healthy)).toBe(false)
  })

  it('(c) limited + directSend=false -> normal path', () => {
    expect(shouldDirectSend({ directSend: false }, limited)).toBe(false)
  })

  it('directSend undefined -> normal path even when limited', () => {
    expect(shouldDirectSend({}, limited)).toBe(false)
  })

  it('null/absent state (treated NOT limited) -> normal path', () => {
    expect(shouldDirectSend({ directSend: true }, null)).toBe(false)
  })
})

describe('readTokenOutageState', () => {
  let dir: string
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  function stateFile(content: string): string {
    dir = mkdtempSync(join(tmpdir(), 'outage-state-'))
    const p = join(dir, 'token-outage-state.json')
    writeFileSync(p, content)
    return p
  }

  it('reads limited:true', () => {
    const p = stateFile(JSON.stringify({ limited: true, enteredAtMs: 1, ackSent: false, capturedCardId: null }))
    expect(readTokenOutageState(p)).toEqual({ limited: true })
  })

  it('reads limited:false', () => {
    const p = stateFile(JSON.stringify({ limited: false, enteredAtMs: 0 }))
    expect(readTokenOutageState(p)).toEqual({ limited: false })
  })

  it('returns null for an absent file (-> not limited)', () => {
    expect(readTokenOutageState(join(tmpdir(), 'no-such-outage-state-xyz.json'))).toBeNull()
  })

  it('returns null for malformed JSON (-> not limited)', () => {
    const p = stateFile('{ not valid json')
    expect(readTokenOutageState(p)).toBeNull()
  })

  it('returns null when limited is not a boolean (defensive)', () => {
    const p = stateFile(JSON.stringify({ limited: 'yes' }))
    expect(readTokenOutageState(p)).toBeNull()
  })

  it('composes with shouldDirectSend: malformed state never fires direct-send', () => {
    const p = stateFile('garbage')
    expect(shouldDirectSend({ directSend: true }, readTokenOutageState(p))).toBe(false)
  })
})
