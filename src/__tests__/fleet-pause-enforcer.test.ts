import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decideEnforcement,
  readEnforcementMode,
  shouldHoldProactiveWork,
  type EnforcementMode,
} from '../web/fleet-pause-enforcer.js'
import { writeFleetPause, clearFleetPause, isFleetPaused } from '../web/fleet-pause.js'

describe('decideEnforcement (pure)', () => {
  const cases: Array<[EnforcementMode, boolean, { hold: boolean; dryRun: boolean }]> = [
    // off: inert in every case -- never hold, never even flag.
    ['off', true, { hold: false, dryRun: false }],
    ['off', false, { hold: false, dryRun: false }],
    // dry-run: never hold, but flag when paused (so logs show what enforce WOULD do).
    ['dry-run', true, { hold: false, dryRun: true }],
    ['dry-run', false, { hold: false, dryRun: false }],
    // enforce: hold iff the fleet is actually paused.
    ['enforce', true, { hold: true, dryRun: false }],
    ['enforce', false, { hold: false, dryRun: false }],
  ]
  it.each(cases)('mode=%s paused=%s', (mode, paused, expected) => {
    expect(decideEnforcement(mode, paused)).toEqual(expected)
  })
})

describe('readEnforcementMode', () => {
  it('defaults to off when unset', () => {
    expect(readEnforcementMode({})).toBe('off')
  })
  it('defaults to off when empty', () => {
    expect(readEnforcementMode({ FLEET_PAUSE_ENFORCE: '' })).toBe('off')
  })
  it('reads enforce', () => {
    expect(readEnforcementMode({ FLEET_PAUSE_ENFORCE: 'enforce' })).toBe('enforce')
  })
  it('reads dry-run', () => {
    expect(readEnforcementMode({ FLEET_PAUSE_ENFORCE: 'dry-run' })).toBe('dry-run')
  })
  it('is case-insensitive and trims', () => {
    expect(readEnforcementMode({ FLEET_PAUSE_ENFORCE: '  ENFORCE ' })).toBe('enforce')
  })
  it('falls back to off on an unknown value (fail-safe: never enforce by accident)', () => {
    expect(readEnforcementMode({ FLEET_PAUSE_ENFORCE: 'garbage' })).toBe('off')
  })
})

describe('shouldHoldProactiveWork (wired gate)', () => {
  it('off mode short-circuits WITHOUT reading the sentinel (zero-overhead inert path)', () => {
    const isPaused = vi.fn(() => { throw new Error('must not be called when off') })
    const held = shouldHoldProactiveWork('schedule:x', { mode: 'off', isPaused })
    expect(held).toBe(false)
    expect(isPaused).not.toHaveBeenCalled()
  })

  it('enforce + paused => holds and logs', () => {
    const log = vi.fn()
    const held = shouldHoldProactiveWork('message:1->dave', {
      mode: 'enforce', isPaused: () => true, nowSec: () => 1000, log,
    })
    expect(held).toBe(true)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][1]).toMatch(/HOLDING/i)
  })

  it('enforce + not paused => proceeds, no log', () => {
    const log = vi.fn()
    const held = shouldHoldProactiveWork('schedule:x', {
      mode: 'enforce', isPaused: () => false, log,
    })
    expect(held).toBe(false)
    expect(log).not.toHaveBeenCalled()
  })

  it('dry-run + paused => proceeds (does NOT hold) but logs what enforce would do', () => {
    const log = vi.fn()
    const held = shouldHoldProactiveWork('schedule:x', {
      mode: 'dry-run', isPaused: () => true, log,
    })
    expect(held).toBe(false)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][1]).toMatch(/dry-run/i)
  })

  it('fail-OPEN: a throwing sentinel read in enforce mode does not hold', () => {
    const held = shouldHoldProactiveWork('schedule:x', {
      mode: 'enforce', isPaused: () => { throw new Error('disk hiccup') },
    })
    expect(held).toBe(false)
  })

  it('passes the resolved nowSec into isPaused', () => {
    const isPaused = vi.fn(() => false)
    shouldHoldProactiveWork('x', { mode: 'enforce', isPaused, nowSec: () => 42 })
    expect(isPaused).toHaveBeenCalledWith(42)
  })
})

describe('shouldHoldProactiveWork + real fleet-pause sentinel (integration)', () => {
  const sentinel = () => join(mkdtempSync(join(tmpdir(), 'enforcer-')), 'paused.json')
  const real = (p: string) => (n: number) => isFleetPaused(n, p)

  it('holds while a written sentinel is active under enforce', () => {
    const p = sentinel()
    writeFleetPause({ pausedAt: 1000, resumeAt: 2000, pct: 99, reason: 'rate-limit' }, p)
    expect(shouldHoldProactiveWork('x', { mode: 'enforce', isPaused: real(p), nowSec: () => 1500 })).toBe(true)
  })

  it('does NOT hold once the sentinel has self-expired (resumeAt passed)', () => {
    const p = sentinel()
    writeFleetPause({ pausedAt: 1000, resumeAt: 2000, pct: 99, reason: 'rate-limit' }, p)
    expect(shouldHoldProactiveWork('x', { mode: 'enforce', isPaused: real(p), nowSec: () => 2500 })).toBe(false)
  })

  it('does NOT hold after the sentinel is cleared (resume)', () => {
    const p = sentinel()
    writeFleetPause({ pausedAt: 1000, resumeAt: 9999999999, pct: 99, reason: 'rate-limit' }, p)
    clearFleetPause(p)
    expect(shouldHoldProactiveWork('x', { mode: 'enforce', isPaused: real(p), nowSec: () => 1500 })).toBe(false)
  })

  it('does NOT hold with the same active sentinel when mode is off (inert default)', () => {
    const p = sentinel()
    writeFleetPause({ pausedAt: 1000, resumeAt: 9999999999, pct: 99, reason: 'rate-limit' }, p)
    expect(shouldHoldProactiveWork('x', { mode: 'off', isPaused: real(p), nowSec: () => 1500 })).toBe(false)
  })
})
