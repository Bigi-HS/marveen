import { describe, it, expect } from 'vitest'
import {
  DELIVERY_MONITOR_AGENT_ID,
  DELIVERY_ABANDONMENT_SENTINEL,
  shouldAlertOnAbandon,
  abandonAlertContent,
  abandonmentRecord,
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

// MEDIUM (PR #130 DA review): the inter-agent abandonment alert can itself go
// undelivered -- e.g. when the abandoned message's recipient IS the wedged
// main agent, the alert queued to main also never lands. A durable JSONL
// record, appended unconditionally, gives a token-free supervisor a tail-able
// trail so the "never drop silently" net cannot itself fall silent.

describe('abandonment sentinel record (d3339db9 MEDIUM)', () => {
  it('writes under the gitignored store/ dir', () => {
    expect(DELIVERY_ABANDONMENT_SENTINEL.startsWith('store/')).toBe(true)
  })

  it('emits a single-object JSON line naming the event, id, parties and age', () => {
    const line = abandonmentRecord(
      { id: 42, from_agent: 'dave', to_agent: 'scout' },
      61 * 60 * 1000,
      Date.parse('2026-06-12T20:00:00.000Z'),
    )
    expect(line).not.toContain('\n')
    const rec = JSON.parse(line)
    expect(rec.event).toBe('delivery-abandoned')
    expect(rec.id).toBe(42)
    expect(rec.from).toBe('dave')
    expect(rec.to).toBe('scout')
    expect(rec.age_min).toBe(61)
    expect(rec.ts).toBe('2026-06-12T20:00:00.000Z')
  })

  it('rounds the age to whole minutes', () => {
    const rec = JSON.parse(
      abandonmentRecord({ id: 1, from_agent: 'a', to_agent: 'b' }, 90 * 1000, 0),
    )
    expect(rec.age_min).toBe(2)
  })

  it('records even a monitor alert that is itself abandoned (no recursion guard here)', () => {
    // The sentinel is the LAST resort, so unlike the inter-agent alert it is
    // written for every abandonment, including an abandoned monitor alert --
    // that case (main unreachable for the whole window) is exactly what must
    // leave a durable trace.
    const rec = JSON.parse(
      abandonmentRecord(
        { id: 7, from_agent: DELIVERY_MONITOR_AGENT_ID, to_agent: 'marveen' },
        60 * 60 * 1000,
        0,
      ),
    )
    expect(rec.from).toBe(DELIVERY_MONITOR_AGENT_ID)
  })
})
