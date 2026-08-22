import { describe, it, expect } from 'vitest'
import { mostRecentRespawn, shouldDeferRespawn } from '../web/channel-monitor.js'

// Thor T6: the main-session respawn time is written from TWO in-process paths
// (keepalive fresh-respawn + hard-restart/inbound escalation) plus an external
// file-stamp watchdog. lastMainRespawnAt() folds all three so whichever stamped
// LAST suppresses the others. Before this there was no test for the combined
// case -- which path defers to which when both fire. These pin that composition.

describe('mostRecentRespawn (cross-path fold)', () => {
  it('returns the latest across keepalive / hard-restart / file stamp', () => {
    expect(mostRecentRespawn(100, 200, 150)).toBe(200) // hard-restart newest
    expect(mostRecentRespawn(300, 200, 150)).toBe(300) // keepalive newest
    expect(mostRecentRespawn(100, 200, 500)).toBe(500) // file watchdog newest
  })
  it('is 0 when no path has respawned', () => {
    expect(mostRecentRespawn(0, 0, 0)).toBe(0)
  })
})

describe('shouldDeferRespawn', () => {
  const GRACE = 360_000
  it('defers within the grace window', () => {
    expect(shouldDeferRespawn(1_000_000, 1_000_000 - 1000, GRACE)).toBe(true)
  })
  it('does not defer once the grace window has passed', () => {
    expect(shouldDeferRespawn(1_000_000, 1_000_000 - GRACE - 1, GRACE)).toBe(false)
  })
  it('does not defer when nothing has respawned yet (lastRespawnAt 0)', () => {
    expect(shouldDeferRespawn(1_000_000, 0, GRACE)).toBe(false)
  })
})

describe('combined two-path defer: which defers which (Thor T6)', () => {
  const GRACE = 360_000 // MARVEEN_POST_RESPAWN_GRACE_MS
  const NOW = 5_000_000

  it('keepalive just respawned -> the hard-restart escalation defers to it', () => {
    const last = mostRecentRespawn(/*keepalive*/ NOW - 1000, /*hardRestart*/ 0, /*file*/ 0)
    expect(last).toBe(NOW - 1000)
    expect(shouldDeferRespawn(NOW, last, GRACE)).toBe(true)
  })

  it('hard-restart just fired -> a fresh escalation defers to it', () => {
    const last = mostRecentRespawn(/*keepalive*/ 0, /*hardRestart*/ NOW - 1000, /*file*/ 0)
    expect(last).toBe(NOW - 1000)
    expect(shouldDeferRespawn(NOW, last, GRACE)).toBe(true)
  })

  it('both fire near-simultaneously -> the LATER stamp wins the suppression window', () => {
    // keepalive at NOW-2000, hard-restart 100ms later at NOW-1900
    const last = mostRecentRespawn(NOW - 2000, NOW - 1900, 0)
    expect(last).toBe(NOW - 1900) // the later of the two
    expect(shouldDeferRespawn(NOW, last, GRACE)).toBe(true)
  })

  it('both respawns are stale -> neither defers, a genuine respawn is allowed', () => {
    const last = mostRecentRespawn(NOW - 2 * GRACE, NOW - 3 * GRACE, 0)
    expect(shouldDeferRespawn(NOW, last, GRACE)).toBe(false)
  })

  it('the external file-stamp watchdog also suppresses both in-process paths', () => {
    const last = mostRecentRespawn(0, 0, NOW - 1000) // only the out-of-process watchdog respawned
    expect(shouldDeferRespawn(NOW, last, GRACE)).toBe(true)
  })
})
