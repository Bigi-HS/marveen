import { describe, it, expect } from 'vitest'
import { decideDeliveryOutcome } from '../web/message-router.js'

// The router injects a message then must decide whether the agent_messages row
// is delivered or should stay pending for a later re-delivery tick. The bug this
// guards: a 'parked' submit (Enter swallowed mid-/compact, residue cleared) used
// to be marked delivered, silently dropping the message so it only ever surfaced
// as a 360-min "recipient never ready" abandon.
describe('decideDeliveryOutcome', () => {
  it('delivers a confirmed submit', () => {
    expect(decideDeliveryOutcome('submitted')).toBe('deliver')
  })

  it('leaves a parked message pending for re-delivery', () => {
    expect(decideDeliveryOutcome('parked')).toBe('leave-pending')
  })

  it('delivers on unknown to avoid double-executing a task that may have landed', () => {
    // 'unknown' means the pane was unreadable / the retry-Enter send failed, so
    // the prompt MAY have executed and nothing was cleared. Re-sending would
    // risk running it twice; treat as delivered rather than loop.
    expect(decideDeliveryOutcome('unknown')).toBe('deliver')
  })
})
