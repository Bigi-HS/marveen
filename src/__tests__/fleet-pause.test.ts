import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readFleetPause,
  writeFleetPause,
  clearFleetPause,
  isFleetPaused,
  type FleetPauseRecord,
} from '../web/fleet-pause.js'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'fleetpause-')), 'sentinel.json')
const rec = (over: Partial<FleetPauseRecord> = {}): FleetPauseRecord => ({
  pausedAt: 1000, resumeAt: 2000, pct: 99, reason: 'test', ...over,
})

describe('fleet-pause sentinel', () => {
  it('round-trips a record through write/read', () => {
    const p = tmp()
    writeFleetPause(rec(), p)
    expect(readFleetPause(p)).toEqual(rec())
  })

  it('reads null when the sentinel is absent', () => {
    expect(readFleetPause(join(tmpdir(), 'does-not-exist-xyz.json'))).toBeNull()
  })

  it('reads null (fail-safe = not paused) on a corrupt or non-record sentinel', () => {
    const p = tmp()
    writeFileSync(p, '{not json')
    expect(readFleetPause(p)).toBeNull()
    writeFileSync(p, JSON.stringify({ nope: true }))
    expect(readFleetPause(p)).toBeNull()
  })

  it('clear removes the sentinel and is idempotent', () => {
    const p = tmp()
    writeFleetPause(rec(), p)
    expect(existsSync(p)).toBe(true)
    clearFleetPause(p)
    expect(existsSync(p)).toBe(false)
    // clearing a missing sentinel is a no-op, not a throw
    expect(() => clearFleetPause(p)).not.toThrow()
  })

  it('isFleetPaused is true only while now < resumeAt', () => {
    const p = tmp()
    writeFleetPause(rec({ resumeAt: 2000 }), p)
    expect(isFleetPaused(1999, p)).toBe(true)
    // self-expiring: at/after resumeAt it reads as NOT paused, so a crashed
    // governor that never cleared the sentinel can't strand the fleet forever.
    expect(isFleetPaused(2000, p)).toBe(false)
    expect(isFleetPaused(2001, p)).toBe(false)
  })

  it('isFleetPaused is false with no sentinel', () => {
    expect(isFleetPaused(1, join(tmpdir(), 'absent-sentinel.json'))).toBe(false)
  })
})
