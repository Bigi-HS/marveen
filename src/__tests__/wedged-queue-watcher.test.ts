import { describe, it, expect } from 'vitest'
import {
  shouldRecoverWedgedQueue,
  isFrozenTuiWedge,
  QUEUE_STALE_MS,
  WEDGE_RECOVERY_BACKOFF_MS,
} from '../web/wedged-queue-watcher.js'
import type { PaneState } from '../pane-state.js'

// Incident 2026-06-14: the main channels session froze on an injected heartbeat
// prompt. The claude process AND the bun channel poller were both alive, but the
// TUI was wedged -- pane not-promptable ('unknown'), no spinner -- and 6 inter-
// agent messages piled up to 100+ min. Every existing main-session detector
// missed it: keepalive-staleness short-circuits on a live poller, the stall
// detector keys off transcript ingestion (a frozen TUI never ingests), and the
// down-handler needs a dead plugin. The router's pending queue is the only
// ground-truth signal immune to TUI-render ambiguity: the router physically
// cannot deliver. shouldRecoverWedgedQueue is the pure decision behind the fix.

// Convenience: the watcher's real thresholds so the tests track production.
const BASE = {
  queueStaleMs: QUEUE_STALE_MS,
  respawnGraceMs: 6 * 60 * 1000,
  recoveryBackoffMs: WEDGE_RECOVERY_BACKOFF_MS,
  msSinceLastMainRespawn: null as number | null,
  msSinceLastRecovery: null as number | null,
}

describe('isFrozenTuiWedge (which pane states are a recoverable wedge)', () => {
  it("treats 'unknown' as a frozen-TUI wedge (no live input box, no spinner)", () => {
    expect(isFrozenTuiWedge('unknown')).toBe(true)
  })

  it('treats a null capture as a wedge (fail toward recoverable; corroborated by the stale queue + double-sample)', () => {
    expect(isFrozenTuiWedge(null)).toBe(true)
  })

  it("does NOT treat 'busy' as a wedge -- a working turn legitimately defers delivery (card 7557a98d)", () => {
    expect(isFrozenTuiWedge('busy')).toBe(false)
  })

  it("does NOT treat 'typing' as a wedge -- text is being composed in the box", () => {
    expect(isFrozenTuiWedge('typing')).toBe(false)
  })

  it("does NOT treat 'idle' as a wedge -- the pane is promptable, so a stale queue is a router problem, not a frozen agent", () => {
    expect(isFrozenTuiWedge('idle')).toBe(false)
  })

  it("does NOT treat 'error' as a wedge -- the thinking-block error path is deliberately alert-only (no auto-reset)", () => {
    expect(isFrozenTuiWedge('error')).toBe(false)
  })
})

describe('shouldRecoverWedgedQueue', () => {
  it('recovers the incident shape: queue stale past threshold + pane not promptable', () => {
    expect(shouldRecoverWedgedQueue({
      ...BASE,
      oldestPendingAgeMs: QUEUE_STALE_MS + 1,
      paneNotPromptable: true,
    })).toBe(true)
  })

  it('does NOT recover when the queue is empty (no undelivered message = no evidence)', () => {
    expect(shouldRecoverWedgedQueue({
      ...BASE,
      oldestPendingAgeMs: null,
      paneNotPromptable: true,
    })).toBe(false)
  })

  it('does NOT recover while the oldest pending message is younger than the stale threshold', () => {
    expect(shouldRecoverWedgedQueue({
      ...BASE,
      oldestPendingAgeMs: QUEUE_STALE_MS - 1,
      paneNotPromptable: true,
    })).toBe(false)
    // exact boundary is "not yet stale"
    expect(shouldRecoverWedgedQueue({
      ...BASE,
      oldestPendingAgeMs: QUEUE_STALE_MS,
      paneNotPromptable: true,
    })).toBe(false)
  })

  it('does NOT recover a busy/idle/promptable pane even with a very old queue (defer, never kill a working or promptable session)', () => {
    expect(shouldRecoverWedgedQueue({
      ...BASE,
      oldestPendingAgeMs: 6 * 60 * 60 * 1000, // 6h
      paneNotPromptable: false,
    })).toBe(false)
  })

  it('does NOT recover inside the post-respawn cold-start grace (a booting session reads as not-promptable)', () => {
    expect(shouldRecoverWedgedQueue({
      ...BASE,
      oldestPendingAgeMs: QUEUE_STALE_MS + 1,
      paneNotPromptable: true,
      msSinceLastMainRespawn: BASE.respawnGraceMs - 1,
    })).toBe(false)
    // at/after the grace it may recover again
    expect(shouldRecoverWedgedQueue({
      ...BASE,
      oldestPendingAgeMs: QUEUE_STALE_MS + 1,
      paneNotPromptable: true,
      msSinceLastMainRespawn: BASE.respawnGraceMs,
    })).toBe(true)
  })

  it('does NOT re-fire inside the recovery backoff (a respawn that did not help must not be hammered)', () => {
    expect(shouldRecoverWedgedQueue({
      ...BASE,
      oldestPendingAgeMs: QUEUE_STALE_MS + 1,
      paneNotPromptable: true,
      msSinceLastRecovery: WEDGE_RECOVERY_BACKOFF_MS - 1,
    })).toBe(false)
    // once the backoff elapses, a still-stuck queue recovers again
    expect(shouldRecoverWedgedQueue({
      ...BASE,
      oldestPendingAgeMs: QUEUE_STALE_MS + 1,
      paneNotPromptable: true,
      msSinceLastRecovery: WEDGE_RECOVERY_BACKOFF_MS,
    })).toBe(true)
  })

  it('a null msSinceLastMainRespawn / msSinceLastRecovery means "no prior" and never blocks (first-ever recovery)', () => {
    expect(shouldRecoverWedgedQueue({
      oldestPendingAgeMs: QUEUE_STALE_MS + 1,
      paneNotPromptable: true,
      queueStaleMs: QUEUE_STALE_MS,
      respawnGraceMs: 6 * 60 * 1000,
      recoveryBackoffMs: WEDGE_RECOVERY_BACKOFF_MS,
      msSinceLastMainRespawn: null,
      msSinceLastRecovery: null,
    })).toBe(true)
  })

  it('grace and backoff are independent gates -- either one alone defers', () => {
    // grace OK, backoff blocks
    expect(shouldRecoverWedgedQueue({
      ...BASE,
      oldestPendingAgeMs: QUEUE_STALE_MS + 1,
      paneNotPromptable: true,
      msSinceLastMainRespawn: BASE.respawnGraceMs + 1,
      msSinceLastRecovery: 1000,
    })).toBe(false)
    // backoff OK, grace blocks
    expect(shouldRecoverWedgedQueue({
      ...BASE,
      oldestPendingAgeMs: QUEUE_STALE_MS + 1,
      paneNotPromptable: true,
      msSinceLastMainRespawn: 1000,
      msSinceLastRecovery: WEDGE_RECOVERY_BACKOFF_MS + 1,
    })).toBe(false)
  })

  it('default thresholds: queue-stale is 10 min, recovery backoff is 30 min', () => {
    expect(QUEUE_STALE_MS).toBe(10 * 60 * 1000)
    expect(WEDGE_RECOVERY_BACKOFF_MS).toBe(30 * 60 * 1000)
  })
})

// Type-level: isFrozenTuiWedge must accept every PaneState plus null so the
// caller can pass a failed capture straight through.
const _allStates: PaneState[] = ['idle', 'busy', 'typing', 'unknown', 'error']
describe('isFrozenTuiWedge totality', () => {
  it('classifies every PaneState without throwing', () => {
    for (const s of _allStates) expect(typeof isFrozenTuiWedge(s)).toBe('boolean')
  })
})
