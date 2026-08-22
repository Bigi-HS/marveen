// Tests for card 4beb20b7 (A3'): escalation CLI boot-grace guard.
//
// After a restart, pre-existing outstanding ACKs with id > cursor AND age > 15min
// would be escalated even though the recipient likely engaged (but the observer
// crashed before writing the cleared record). The fix: on the first ~60s after
// server boot, advance the cursor to high-water without sending a Telegram alert.

import { describe, it, expect } from 'vitest'
import { isWithinEscalationBootGrace, ESCALATION_BOOT_GRACE_MS } from '../delivery-ack-cli.js'

describe('isWithinEscalationBootGrace', () => {
  it('returns true when within the grace window', () => {
    const bootAt = 1_000_000_000_000
    const now = bootAt + ESCALATION_BOOT_GRACE_MS - 1
    expect(isWithinEscalationBootGrace(bootAt, now)).toBe(true)
  })

  it('returns false when grace period has elapsed', () => {
    const bootAt = 1_000_000_000_000
    const now = bootAt + ESCALATION_BOOT_GRACE_MS
    expect(isWithinEscalationBootGrace(bootAt, now)).toBe(false)
  })

  it('returns false when bootAt is 0 (file absent / unreadable)', () => {
    expect(isWithinEscalationBootGrace(0, Date.now())).toBe(false)
  })

  it('ESCALATION_BOOT_GRACE_MS is exported and positive', () => {
    expect(typeof ESCALATION_BOOT_GRACE_MS).toBe('number')
    expect(ESCALATION_BOOT_GRACE_MS).toBeGreaterThan(0)
  })
})
