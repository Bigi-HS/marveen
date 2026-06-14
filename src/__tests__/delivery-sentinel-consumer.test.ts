import { describe, it, expect } from 'vitest'
import {
  EMPTY_SENTINEL_CURSOR,
  selectSentinelEscalations,
  sentinelAlertText,
  normalizeCursor,
  type SentinelCursor,
} from '../web/delivery-sentinel-consumer.js'
import type { AbandonmentEvent, AbandonmentPhase } from '../web/delivery-alert.js'
import { DELIVERY_MONITOR_AGENT_ID } from '../web/delivery-alert.js'

// Card d37df625 + 7557a98d: the CONSUMER for the abandonment sentinel. A
// token-free reader escalates abandoned/overdue deliveries out-of-band (Telegram
// fallback). Since 7557a98d the router re-appends a row for the SAME id on a
// throttled cadence (the periodic re-alert), so the cursor is per-id-by-ts (not
// a scalar high-water id) and the same id re-escalates when a fresher row lands.

const ev = (
  id: number,
  ts: string,
  opts: { to?: string; from?: string; age_min?: number; phase?: AbandonmentPhase } = {},
): AbandonmentEvent => ({
  ts,
  event: 'delivery-abandoned',
  id,
  from: opts.from ?? 'dave',
  to: opts.to ?? 'marveen',
  age_min: opts.age_min ?? 65,
  phase: opts.phase ?? 'dropped',
})

const T0 = '2026-06-13T12:00:00.000Z'
const T1 = '2026-06-13T13:00:00.000Z' // one hour later (a fresh re-alert round)
const ms = (iso: string) => Date.parse(iso)

describe('selectSentinelEscalations', () => {
  it('baselines on the first run (empty cursor): records per-id ts, escalates nothing', () => {
    const plan = selectSentinelEscalations([ev(10, T0), ev(11, T0)], EMPTY_SENTINEL_CURSOR)
    expect(plan.baselined).toBe(true)
    expect(plan.escalations).toEqual([])
    expect(plan.nextCursor.lastEscalatedTs).toEqual({ 10: ms(T0), 11: ms(T0) })
  })

  it('does not baseline on an empty file (empty cursor stays empty)', () => {
    const plan = selectSentinelEscalations([], EMPTY_SENTINEL_CURSOR)
    expect(plan.baselined).toBe(false)
    expect(plan.escalations).toEqual([])
    expect(plan.nextCursor.lastEscalatedTs).toEqual({})
  })

  it('escalates an id never seen before', () => {
    const plan = selectSentinelEscalations([ev(10, T0), ev(12, T0)], { lastEscalatedTs: { 10: ms(T0) } })
    expect(plan.escalations.map((e) => e.id)).toEqual([12])
    expect(plan.nextCursor.lastEscalatedTs).toEqual({ 10: ms(T0), 12: ms(T0) })
  })

  it('RE-escalates the same id when a fresher row (newer ts) arrives -- the periodic re-alert', () => {
    // id 10 was last escalated at T0; a new round wrote a T1 row for it.
    const plan = selectSentinelEscalations([ev(10, T0), ev(10, T1)], { lastEscalatedTs: { 10: ms(T0) } })
    expect(plan.escalations.map((e) => e.id)).toEqual([10])
    expect(plan.escalations[0]!.ts).toBe(T1) // the latest row, not the stale one
    expect(plan.nextCursor.lastEscalatedTs[10]).toBe(ms(T1))
  })

  it('does NOT re-escalate when the latest row was already escalated (same ts)', () => {
    const plan = selectSentinelEscalations([ev(10, T0), ev(10, T0)], { lastEscalatedTs: { 10: ms(T0) } })
    expect(plan.escalations).toEqual([])
    expect(plan.nextCursor.lastEscalatedTs).toEqual({ 10: ms(T0) })
  })

  it('collapses multiple rows per id to the single latest, escalating it once', () => {
    const plan = selectSentinelEscalations(
      [ev(10, T0), ev(10, T1), ev(11, T0)],
      { lastEscalatedTs: {} },
      { baselineOnFirstRun: false },
    )
    expect(plan.escalations.map((e) => e.id)).toEqual([10, 11])
    expect(plan.escalations.find((e) => e.id === 10)!.ts).toBe(T1)
  })

  it('sorts fresh ids ascending and caps per run, leaving the rest for next tick', () => {
    const plan = selectSentinelEscalations(
      [ev(15, T0), ev(13, T0), ev(14, T0), ev(16, T0)],
      { lastEscalatedTs: {} },
      { maxPerRun: 2, baselineOnFirstRun: false },
    )
    expect(plan.escalations.map((e) => e.id)).toEqual([13, 14])
    // cursor advances only through what was escalated, so 15/16 escalate next run
    expect(plan.nextCursor.lastEscalatedTs).toEqual({ 13: ms(T0), 14: ms(T0) })
  })

  it('ignores rows with a non-finite id or an unparseable ts', () => {
    const bad = { ...ev(0, T0), id: NaN } as unknown as AbandonmentEvent
    const badTs = ev(21, 'not-a-date')
    const plan = selectSentinelEscalations([bad, badTs, ev(20, T0)], { lastEscalatedTs: {} }, { baselineOnFirstRun: false })
    expect(plan.escalations.map((e) => e.id)).toEqual([20])
  })

  it('baseline disabled: escalates history too (operator opt-in)', () => {
    const plan = selectSentinelEscalations([ev(10, T0), ev(11, T0)], EMPTY_SENTINEL_CURSOR, { baselineOnFirstRun: false })
    expect(plan.baselined).toBe(false)
    expect(plan.escalations.map((e) => e.id)).toEqual([10, 11])
  })
})

// Card 6774b3db: out-of-band recursion guard. The in-band alert path already
// refuses to alert about an abandoned delivery-monitor alert (shouldAlertOnAbandon
// returns false for it). But the OUT-OF-BAND sentinel had no such guard, so when
// the main agent stayed busy, the monitor's own undelivered alerts were escalated
// to the operator on Telegram -- on 2026-06-14 that was 47% of the overnight
// backstop flood (the backstop alerting about the backstop). The underlying real
// message is independently traced and escalated, so a monitor-origin row is pure
// double-counting: it must be excluded from escalation (the JSONL write stays for
// forensics, handled on the write side).
describe('selectSentinelEscalations recursion guard (monitor-origin rows)', () => {
  const mon = (id: number, ts: string) => ev(id, ts, { from: DELIVERY_MONITOR_AGENT_ID })

  it('never escalates a delivery-monitor-origin row, only real-sender rows', () => {
    const plan = selectSentinelEscalations(
      [mon(50, T0), ev(51, T0, { from: 'thor' })],
      { lastEscalatedTs: {} },
      { baselineOnFirstRun: false },
    )
    expect(plan.escalations.map((e) => e.id)).toEqual([51])
  })

  it('does not let a monitor-origin row enter the cursor', () => {
    const plan = selectSentinelEscalations(
      [mon(50, T0), ev(51, T0, { from: 'thor' })],
      { lastEscalatedTs: {} },
      { baselineOnFirstRun: false },
    )
    expect(plan.nextCursor.lastEscalatedTs).toEqual({ 51: ms(T0) })
  })

  it('escalates nothing when every row is monitor-origin (no operator ping at all)', () => {
    const plan = selectSentinelEscalations(
      [mon(50, T0), mon(51, T1)],
      { lastEscalatedTs: {} },
      { baselineOnFirstRun: false },
    )
    expect(plan.escalations).toEqual([])
    expect(plan.nextCursor.lastEscalatedTs).toEqual({})
  })

  it('baselines only the real rows on first run, ignoring monitor-origin rows', () => {
    const plan = selectSentinelEscalations([mon(50, T0), ev(51, T0, { from: 'dave' })], EMPTY_SENTINEL_CURSOR)
    expect(plan.baselined).toBe(true)
    expect(plan.nextCursor.lastEscalatedTs).toEqual({ 51: ms(T0) })
  })
})

describe('normalizeCursor (migration)', () => {
  it('migrates a pre-7557a98d scalar { lastEscalatedId } to an empty per-id cursor (baseline next run)', () => {
    expect(normalizeCursor({ lastEscalatedId: 2152 })).toEqual({ lastEscalatedTs: {} })
  })

  it('preserves a valid per-id cursor, dropping non-numeric entries', () => {
    const c = normalizeCursor({ lastEscalatedTs: { 10: 1000, 11: 'nope', 12: 2000 } })
    expect(c.lastEscalatedTs).toEqual({ 10: 1000, 12: 2000 })
  })

  it('returns an empty cursor for garbage / null', () => {
    expect(normalizeCursor(null)).toEqual({ lastEscalatedTs: {} })
    expect(normalizeCursor('xyz')).toEqual({ lastEscalatedTs: {} })
    expect(normalizeCursor(42)).toEqual({ lastEscalatedTs: {} })
  })
})

describe('sentinelAlertText', () => {
  it('names each delivery with id, parties and age', () => {
    const txt = sentinelAlertText([ev(42, T0, { to: 'marveen', from: 'thor', age_min: 70 })])
    expect(txt).toContain('#42')
    expect(txt).toContain('thor')
    expect(txt).toContain('marveen')
    expect(txt).toContain('70')
  })

  it('summarises a count and emits one line per message', () => {
    const txt = sentinelAlertText([ev(1, T0), ev(2, T0), ev(3, T0)])
    expect(txt).toContain('3')
    expect(txt.split('\n').filter((l) => l.includes('#')).length).toBe(3)
  })

  it('distinguishes an overdue (still retrying) message from a dropped one', () => {
    const overdue = sentinelAlertText([ev(5, T0, { phase: 'overdue' })])
    expect(overdue.toLowerCase()).toContain('still retrying')
    expect(overdue.toLowerCase()).toContain('no action')
    const dropped = sentinelAlertText([ev(6, T0, { phase: 'dropped' })])
    expect(dropped.toLowerCase()).toContain('given up')
    expect(dropped.toLowerCase()).toContain('re-send')
  })

  it('treats a mixed batch as actionable (any dropped -> re-send advice)', () => {
    const txt = sentinelAlertText([ev(5, T0, { phase: 'overdue' }), ev(6, T0, { phase: 'dropped' })])
    expect(txt.toLowerCase()).toContain('re-send')
  })

  it('returns empty string for no escalations (caller sends nothing)', () => {
    expect(sentinelAlertText([])).toBe('')
  })
})

// Type-only guard: the cursor shape the CLI persists must round-trip through JSON.
describe('SentinelCursor JSON round-trip', () => {
  it('survives stringify/parse via normalizeCursor', () => {
    const c: SentinelCursor = { lastEscalatedTs: { 10: 1000, 12: 2000 } }
    expect(normalizeCursor(JSON.parse(JSON.stringify(c)))).toEqual(c)
  })
})
