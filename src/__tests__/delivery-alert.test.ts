import { describe, it, expect } from 'vitest'
import {
  DELIVERY_MONITOR_AGENT_ID,
  shouldAlertOnAbandon,
  abandonAlertContent,
} from '../web/delivery-alert.js'

// Defense-in-depth for d3339db9: an abandoned inter-agent message must
// never vanish silently. The router enqueues a delivery-dropped alert to
// the main agent; these pin the pure decision + content.

describe('delivery-dropped alert (d3339db9 defense-in-depth)', () => {
  it('alerts for an ordinary abandoned message', () => {
    expect(shouldAlertOnAbandon('quill')).toBe(true)
    expect(shouldAlertOnAbandon('marveen')).toBe(true)
  })

  it('does NOT alert about an abandoned alert (recursion guard)', () => {
    // A monitor alert that is itself abandoned (main agent unreachable for
    // the whole window) must not spawn another alert.
    expect(shouldAlertOnAbandon(DELIVERY_MONITOR_AGENT_ID)).toBe(false)
  })

  it('names the id, parties, and age, and states it was not delivered', () => {
    const content = abandonAlertContent(
      { id: 42, from_agent: 'dave', to_agent: 'scout' },
      61 * 60 * 1000,
    )
    expect(content).toContain('#42')
    expect(content).toContain('"dave"')
    expect(content).toContain('"scout"')
    expect(content).toContain('61 min')
    expect(content).toContain('NOT delivered')
  })

  it('rounds the age to whole minutes', () => {
    const content = abandonAlertContent(
      { id: 1, from_agent: 'a', to_agent: 'b' },
      90 * 1000, // 1.5 min -> 2
    )
    expect(content).toContain('2 min')
  })
})
