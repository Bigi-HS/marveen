import { describe, it, expect } from 'vitest'
import {
  DELIVERY_MONITOR_AGENT_ID,
  DELIVERY_ABANDONMENT_SENTINEL,
  shouldAlertOnAbandon,
  abandonAlertContent,
  abandonmentRecord,
  parseAbandonmentSentinel,
  abandonmentRate,
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

// Card 7557a98d: a busy recipient = defer, never drop. The 60-min overdue alert
// must read as "still retrying" (no re-send), distinct from the 6h hard drop.
describe('abandonAlertContent phase (card 7557a98d)', () => {
  it('overdue: states it is NOT dropped and is still being retried', () => {
    const content = abandonAlertContent({ id: 9, from_agent: 'dave', to_agent: 'marveen' }, 60 * 60 * 1000, 'overdue')
    expect(content).toContain('#9')
    expect(content).toContain('OVERDUE')
    expect(content).toContain('NOT dropped')
    expect(content.toLowerCase()).toContain('retrying')
  })

  it('dropped (default): keeps the original "NOT delivered / re-send" wording', () => {
    const content = abandonAlertContent({ id: 9, from_agent: 'dave', to_agent: 'marveen' }, 6 * 60 * 60 * 1000, 'dropped')
    expect(content).toContain('DROPPED')
    expect(content).toContain('NOT delivered')
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

  it('records the phase, defaulting to "dropped" for back-compat', () => {
    const dflt = JSON.parse(abandonmentRecord({ id: 1, from_agent: 'a', to_agent: 'b' }, 0, 0))
    expect(dflt.phase).toBe('dropped')
    const overdue = JSON.parse(abandonmentRecord({ id: 1, from_agent: 'a', to_agent: 'b' }, 0, 0, 'overdue'))
    expect(overdue.phase).toBe('overdue')
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

// Abandon-rate metric (card 732bb084). The default-flip (fail-safe state
// machine, separate card) trades false-READY for false-BUSY, which surfaces as
// a RISE in abandonments. This metric is the safety net: a baseline measured
// from the durable sentinel lets that change be validated, not guessed.

describe('parseAbandonmentSentinel', () => {
  it('parses well-formed delivery-abandoned lines and skips blanks/garbage', () => {
    const raw = [
      abandonmentRecord({ id: 1, from_agent: 'a', to_agent: 'b' }, 60 * 60 * 1000, 1000),
      '',
      'not json at all',
      '{"event":"something-else","ts":"2026-06-13T00:00:00.000Z"}',
      abandonmentRecord({ id: 2, from_agent: 'c', to_agent: 'b' }, 60 * 60 * 1000, 2000),
      '   ',
    ].join('\n')
    const events = parseAbandonmentSentinel(raw)
    expect(events.map((e) => e.id)).toEqual([1, 2])
    expect(events.every((e) => e.event === 'delivery-abandoned')).toBe(true)
  })

  it('returns an empty array for empty input', () => {
    expect(parseAbandonmentSentinel('')).toEqual([])
  })

  it('reads the phase, defaulting a legacy (phase-less) row to "dropped"', () => {
    const raw = [
      '{"event":"delivery-abandoned","ts":"2026-06-13T00:00:00.000Z","id":1,"from":"a","to":"b","age_min":65}', // legacy
      abandonmentRecord({ id: 2, from_agent: 'a', to_agent: 'b' }, 60 * 60 * 1000, 2000, 'overdue'),
    ].join('\n')
    const events = parseAbandonmentSentinel(raw)
    expect(events.find((e) => e.id === 1)!.phase).toBe('dropped')
    expect(events.find((e) => e.id === 2)!.phase).toBe('overdue')
  })
})

describe('abandonmentRate', () => {
  const mkEvent = (id: number, to: string, ts: string) =>
    JSON.parse(abandonmentRecord({ id, from_agent: 'x', to_agent: to }, 0, Date.parse(ts)))

  it('counts only events within the trailing window', () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z')
    const events = [
      mkEvent(1, 'marveen', '2026-06-13T11:30:00.000Z'), // 30 min ago -> in
      mkEvent(2, 'marveen', '2026-06-13T11:10:00.000Z'), // 50 min ago -> in
      mkEvent(3, 'thor', '2026-06-13T10:00:00.000Z'), //   2 h ago   -> out
    ]
    const rate = abandonmentRate(events, 60 * 60 * 1000, now)
    expect(rate.count).toBe(2)
    expect(rate.windowMs).toBe(60 * 60 * 1000)
    expect(rate.byRecipient).toEqual({ marveen: 2 })
  })

  it('groups by recipient to surface a single wedged target', () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z')
    const events = [
      mkEvent(1, 'marveen', '2026-06-13T11:55:00.000Z'),
      mkEvent(2, 'thor', '2026-06-13T11:50:00.000Z'),
      mkEvent(3, 'marveen', '2026-06-13T11:45:00.000Z'),
    ]
    const rate = abandonmentRate(events, 60 * 60 * 1000, now)
    expect(rate.count).toBe(3)
    expect(rate.byRecipient).toEqual({ marveen: 2, thor: 1 })
  })

  it('excludes future-dated or unparseable timestamps (clock skew)', () => {
    const now = Date.parse('2026-06-13T12:00:00.000Z')
    const events = [
      mkEvent(1, 'marveen', '2026-06-13T11:00:00.000Z'), // in
      mkEvent(2, 'marveen', '2026-06-13T13:00:00.000Z'), // future -> out
      { ts: 'not-a-date', event: 'delivery-abandoned', id: 3, from: 'x', to: 'marveen', age_min: 0 },
    ]
    const rate = abandonmentRate(events, 2 * 60 * 60 * 1000, now)
    expect(rate.count).toBe(1)
  })

  it('is zero over a window with no events', () => {
    const rate = abandonmentRate([], 60 * 60 * 1000, Date.parse('2026-06-13T12:00:00.000Z'))
    expect(rate.count).toBe(0)
    expect(rate.byRecipient).toEqual({})
  })
})
