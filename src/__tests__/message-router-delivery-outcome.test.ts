import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { decideDeliveryOutcome } from '../web/message-router.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER_SRC = readFileSync(join(__dirname, '..', 'web', 'message-router.ts'), 'utf8')

// Card 2adc8c5a: hard-fail block must notify the SENDER directly (not only the
// orchestrator). Source audit pins the wiring so a refactor cannot accidentally
// remove the sender path.
describe('message-router hard-fail: sender notified on delivery drop (card 2adc8c5a)', () => {
  it('imports senderAbandonAlertContent from delivery-alert', () => {
    expect(ROUTER_SRC).toMatch(/senderAbandonAlertContent/)
  })

  it('sends a delivery-dropped message to msg.from_agent in the hard-fail block', () => {
    // The sender notification targets from_agent directly (breaks orchestrator-down circularity)
    expect(ROUTER_SRC).toMatch(/createAgentMessage\(DELIVERY_MONITOR_AGENT_ID,\s*msg\.from_agent,\s*senderAbandonAlertContent/)
  })

  it('still sends the orchestrator alert (secondary, kept for observability)', () => {
    expect(ROUTER_SRC).toMatch(/createAgentMessage\(DELIVERY_MONITOR_AGENT_ID,\s*MAIN_AGENT_ID,\s*abandonAlertContent/)
  })

  it('sender notification is skipped when sender IS the orchestrator (no duplicate)', () => {
    // The guard `msg.from_agent !== MAIN_AGENT_ID` prevents duplicate messages
    // when the orchestrator itself sent the message that was dropped.
    expect(ROUTER_SRC).toMatch(/from_agent\s*!==\s*MAIN_AGENT_ID/)
  })
})

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
