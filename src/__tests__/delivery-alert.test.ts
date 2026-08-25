import { describe, it, expect } from 'vitest'
import {
  DELIVERY_MONITOR_AGENT_ID,
  DELIVERY_ABANDONMENT_SENTINEL,
  shouldAlertOnAbandon,
  alertInBand,
  abandonAlertContent,
  senderAbandonAlertContent,
  abandonmentRecord,
  parseAbandonmentSentinel,
  abandonmentRate,
  capJsonlTrail,
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

  it('defaults to raw ids when no resolver is given (backward compatible)', () => {
    const content = abandonAlertContent(
      { id: 5, from_agent: 'marveen', to_agent: 'scout' },
      60 * 60 * 1000,
    )
    expect(content).toContain('"marveen"')
    expect(content).toContain('"scout"')
  })

  it('resolves party ids to Boss-facing display names via the injected resolver (b79a5d3a)', () => {
    const resolve = (id: string): string =>
      ({ marveen: 'NoA', scout: 'Dr. Stone' } as Record<string, string>)[id] ?? id
    const content = abandonAlertContent(
      { id: 7, from_agent: 'marveen', to_agent: 'scout' },
      60 * 60 * 1000,
      resolve,
    )
    expect(content).toContain('"NoA"')
    expect(content).toContain('"Dr. Stone"')
    // the recipient appears twice (parties + "session health"): both resolved
    expect(content).not.toContain('"scout"')
    expect(content).not.toContain('"marveen"')
  })
})

// Card 2adc8c5a: sender-facing alert content. When a message is dropped, the
// SENDER needs to know (they have the context to decide re-send). The orchestrator
// alert is secondary and circular (if the orchestrator is down, its alert also
// stalls). The sender alert is sent to msg.from_agent directly.
describe('senderAbandonAlertContent (card 2adc8c5a)', () => {
  it('names the id, parties, age, and states the message was NOT delivered', () => {
    const content = senderAbandonAlertContent(
      { id: 42, from_agent: 'dave', to_agent: 'scout' },
      61 * 60 * 1000,
    )
    expect(content).toContain('#42')
    expect(content).toContain('scout')
    expect(content).toContain('61 min')
    expect(content).toContain('NOT delivered')
  })

  it('resolves party names via injected resolver', () => {
    const resolve = (id: string): string =>
      ({ scout: 'Dr. Stone' } as Record<string, string>)[id] ?? id
    const content = senderAbandonAlertContent(
      { id: 7, from_agent: 'dave', to_agent: 'scout' },
      60 * 60 * 1000,
      resolve,
    )
    expect(content).toContain('"Dr. Stone"')
    expect(content).not.toContain('"scout"')
  })

  it('is distinct from the orchestrator-facing abandonAlertContent', () => {
    const msg = { id: 1, from_agent: 'dave', to_agent: 'scout' }
    const ageMs = 60 * 60 * 1000
    const sender = senderAbandonAlertContent(msg, ageMs)
    const orchestrator = abandonAlertContent(msg, ageMs)
    // Both describe the same drop but from different perspectives
    expect(sender).not.toBe(orchestrator)
  })
})

// Card f1ea52c0 / Boss 2026-06-22: alert noise. Only a permanent 'dropped'
// give-up raises an in-band Boss alert; a transient 'overdue' (still retrying)
// is sentinel-only. The recursion guard still suppresses an abandoned monitor
// alert.
describe('alertInBand (card f1ea52c0 alert-policy)', () => {
  it('does NOT alert in-band for the transient overdue phase', () => {
    expect(alertInBand('overdue', 'dave')).toBe(false)
    expect(alertInBand('overdue', 'quill')).toBe(false)
  })

  it('alerts in-band for a permanent dropped give-up', () => {
    expect(alertInBand('dropped', 'dave')).toBe(true)
    expect(alertInBand('dropped', 'quill')).toBe(true)
  })

  it('never alerts about an abandoned monitor alert, even when dropped (recursion guard)', () => {
    expect(alertInBand('dropped', DELIVERY_MONITOR_AGENT_ID)).toBe(false)
    expect(alertInBand('overdue', DELIVERY_MONITOR_AGENT_ID)).toBe(false)
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

// Card 681f99b0 (A2): the abandonment trail accumulates one row per abandonment
// plus per throttled re-alert and has no fold-collapse (every row is a distinct
// historical event), so its only bound is a size cap. capJsonlTrail keeps the
// NEWEST maxLines rows (the consumer cursors by per-id ts; dropped rows are
// already-escalated history) and returns null when no trim is needed.
describe('capJsonlTrail (A2 abandonment size-cap rotation)', () => {
  const line = (i: number) => abandonmentRecord({ id: i, from_agent: 'a', to_agent: 'b' }, 60000, 1000 * i)

  it('returns null when at or under the cap (no rewrite churn)', () => {
    const raw = [line(1), line(2), line(3)].join('\n') + '\n'
    expect(capJsonlTrail(raw, 3)).toBeNull()
    expect(capJsonlTrail(raw, 10)).toBeNull()
    expect(capJsonlTrail('', 5)).toBeNull()
  })

  it('keeps the newest maxLines rows when over the cap', () => {
    const raw = [line(1), line(2), line(3), line(4), line(5)].join('\n') + '\n'
    const capped = capJsonlTrail(raw, 2)
    expect(capped).not.toBeNull()
    const kept = parseAbandonmentSentinel(capped!)
    expect(kept.map((e) => e.id)).toEqual([4, 5])
    expect(capped!.endsWith('\n')).toBe(true)
  })

  it('ignores blank lines when counting and trimming', () => {
    const raw = '\n' + line(1) + '\n\n' + line(2) + '\n' + line(3) + '\n\n'
    // three real rows, cap 3 -> no trim needed despite the blank lines.
    expect(capJsonlTrail(raw, 3)).toBeNull()
    const capped = capJsonlTrail(raw, 1)
    expect(parseAbandonmentSentinel(capped!).map((e) => e.id)).toEqual([3])
  })
})
