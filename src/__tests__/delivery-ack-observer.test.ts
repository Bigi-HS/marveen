// Tests for card 6e81183f (A4): boot-grace guard in the ACK clear-observer.
//
// During the first BOOT_GRACE_MS after server start, the observer must NOT
// clear any pending ACKs even when a recipient pane appears "busy". A stale
// busy observation from a pre-restart turn can falsely clear an ACK whose
// message was injected before the restart; the grace period lets those
// pre-restart turns settle to idle before we start clearing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  startAckClearObserver,
  __resetAckObserverState,
  BOOT_GRACE_MS,
  type AckObserverDeps,
} from '../web/delivery-ack-observer.js'

function makeDeps(override: Partial<AckObserverDeps> = {}): AckObserverDeps {
  return {
    readAckFile: override.readAckFile ?? (() => null),
    recipientBusy: override.recipientBusy ?? (() => false),
    appendRecord: override.appendRecord ?? vi.fn(),
    nowMs: override.nowMs ?? (() => Date.now()),
    ...override,
  }
}

// Build a valid pending-ack JSONL record matching PendingAckEvent.
function makePendingLine(deliveredAtMs: number): string {
  return JSON.stringify({
    event: 'delivery-ack-pending',
    id: 1,
    from: 'dave',
    to: 'marveen',
    ts: new Date(deliveredAtMs).toISOString(),
    delivered_at_ms: deliveredAtMs,
  }) + '\n'
}

beforeEach(() => {
  vi.useFakeTimers()
  __resetAckObserverState()
})

afterEach(() => {
  vi.useRealTimers()
  __resetAckObserverState()
})

describe('boot-grace guard (card 6e81183f)', () => {
  it('does not clear ACKs during the boot-grace window even if recipient is busy', () => {
    const appendRecord = vi.fn()
    // bootTime well before the delivered_at_ms so selectAcksToClear would
    // normally clear -- the grace guard must suppress it.
    const bootTime = 1_000_000_000_000
    const pendingLine = makePendingLine(bootTime - 60_000) // delivered 1 min before boot

    vi.setSystemTime(bootTime)

    // nowMs stays constant at bootTime (within grace for the full test)
    const deps = makeDeps({
      readAckFile: () => pendingLine,
      recipientBusy: () => true,
      appendRecord,
      nowMs: () => bootTime, // bootTime - bootStartedAt = 0 < BOOT_GRACE_MS
    })

    const handle = startAckClearObserver(deps)
    try {
      vi.advanceTimersByTime(BOOT_GRACE_MS - 1)
      expect(appendRecord).not.toHaveBeenCalled()
    } finally {
      clearInterval(handle)
    }
  })

  it('clears ACKs once the grace period has elapsed', () => {
    const appendRecord = vi.fn()
    const bootTime = 1_000_000_000_000
    // delivered_at_ms is well before nowMs so selectAcksToClear passes the guard
    const pendingLine = makePendingLine(bootTime - 60_000)

    vi.setSystemTime(bootTime)

    // startAckClearObserver is called when nowMs() = bootTime
    // -> bootStartedAt = bootTime
    // After advancing, nowMs() returns bootTime + BOOT_GRACE_MS + 1
    // -> nowMs() - bootStartedAt = BOOT_GRACE_MS + 1 -> grace over
    let currentNow = bootTime
    const deps = makeDeps({
      readAckFile: () => pendingLine,
      recipientBusy: () => true,
      appendRecord,
      nowMs: () => currentNow,
    })

    const handle = startAckClearObserver(deps)
    try {
      currentNow = bootTime + BOOT_GRACE_MS + 1
      vi.advanceTimersByTime(BOOT_GRACE_MS + 2001)
      expect(appendRecord).toHaveBeenCalled()
    } finally {
      clearInterval(handle)
    }
  })

  it('no-ops when the pending-ack file does not exist (readAckFile returns null)', () => {
    const appendRecord = vi.fn()
    const bootTime = 1_000_000_000_000
    vi.setSystemTime(bootTime)

    let currentNow = bootTime
    const deps = makeDeps({
      readAckFile: () => null, // file absent
      recipientBusy: () => true,
      appendRecord,
      nowMs: () => currentNow,
    })

    const handle = startAckClearObserver(deps)
    try {
      currentNow = bootTime + BOOT_GRACE_MS + 1
      vi.advanceTimersByTime(BOOT_GRACE_MS + 2001)
      expect(appendRecord).not.toHaveBeenCalled()
    } finally {
      clearInterval(handle)
    }
  })

  it('BOOT_GRACE_MS is exported and is a reasonable positive value', () => {
    expect(typeof BOOT_GRACE_MS).toBe('number')
    expect(BOOT_GRACE_MS).toBeGreaterThan(0)
    expect(BOOT_GRACE_MS).toBeLessThanOrEqual(60_000)
  })
})
