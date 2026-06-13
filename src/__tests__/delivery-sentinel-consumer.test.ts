import { describe, it, expect } from 'vitest'
import {
  EMPTY_SENTINEL_CURSOR,
  selectSentinelEscalations,
  sentinelAlertText,
} from '../web/delivery-sentinel-consumer.js'
import type { AbandonmentEvent } from '../web/delivery-alert.js'

// Card d37df625: the CONSUMER for the abandonment sentinel (PR #130 wrote the
// WRITE side). A token-free reader escalates abandoned deliveries out-of-band
// (Telegram fallback) so the in-band alert being lost no longer means a 6-hour
// silent drop. These pin the pure decision: which sentinel lines are new since
// the cursor and warrant escalation, and how the cursor advances.

const ev = (id: number, to = 'marveen', from = 'dave', age_min = 65): AbandonmentEvent => ({
  ts: '2026-06-13T12:00:00.000Z',
  event: 'delivery-abandoned',
  id,
  from,
  to,
  age_min,
})

describe('selectSentinelEscalations', () => {
  it('baselines on the first run (cursor at 0): advances past history without escalating', () => {
    const plan = selectSentinelEscalations([ev(10), ev(11), ev(12)], EMPTY_SENTINEL_CURSOR)
    expect(plan.baselined).toBe(true)
    expect(plan.escalations).toEqual([])
    expect(plan.nextCursor.lastEscalatedId).toBe(12)
  })

  it('does not baseline when there is no history (empty file, cursor 0 stays 0)', () => {
    const plan = selectSentinelEscalations([], EMPTY_SENTINEL_CURSOR)
    expect(plan.baselined).toBe(false)
    expect(plan.escalations).toEqual([])
    expect(plan.nextCursor.lastEscalatedId).toBe(0)
  })

  it('escalates only events with id beyond the cursor', () => {
    const plan = selectSentinelEscalations(
      [ev(10), ev(11), ev(12)],
      { lastEscalatedId: 11 },
    )
    expect(plan.baselined).toBe(false)
    expect(plan.escalations.map((e) => e.id)).toEqual([12])
    expect(plan.nextCursor.lastEscalatedId).toBe(12)
  })

  it('re-escalates nothing when the cursor is already current', () => {
    const plan = selectSentinelEscalations([ev(10), ev(11)], { lastEscalatedId: 11 })
    expect(plan.escalations).toEqual([])
    expect(plan.nextCursor.lastEscalatedId).toBe(11)
  })

  it('sorts fresh events by id and caps per run, leaving the rest for next tick', () => {
    const events = [ev(15), ev(13), ev(14), ev(16)]
    const plan = selectSentinelEscalations(events, { lastEscalatedId: 12 }, { maxPerRun: 2 })
    expect(plan.escalations.map((e) => e.id)).toEqual([13, 14])
    // cursor advances only through what was escalated, so 15/16 escalate next run
    expect(plan.nextCursor.lastEscalatedId).toBe(14)
  })

  it('ignores events with a non-finite id (malformed sentinel row)', () => {
    const bad = { ...ev(0), id: NaN } as unknown as AbandonmentEvent
    const plan = selectSentinelEscalations([bad, ev(20)], { lastEscalatedId: 5 })
    expect(plan.escalations.map((e) => e.id)).toEqual([20])
    expect(plan.nextCursor.lastEscalatedId).toBe(20)
  })

  it('baseline disabled: escalates history too (operator opt-in)', () => {
    const plan = selectSentinelEscalations(
      [ev(10), ev(11)],
      EMPTY_SENTINEL_CURSOR,
      { baselineOnFirstRun: false },
    )
    expect(plan.baselined).toBe(false)
    expect(plan.escalations.map((e) => e.id)).toEqual([10, 11])
    expect(plan.nextCursor.lastEscalatedId).toBe(11)
  })
})

describe('sentinelAlertText', () => {
  it('names each dropped delivery with id, parties and age', () => {
    const txt = sentinelAlertText([ev(42, 'marveen', 'thor', 70)])
    expect(txt).toContain('#42')
    expect(txt).toContain('thor')
    expect(txt).toContain('marveen')
    expect(txt).toContain('70')
  })

  it('summarises a count for multiple drops', () => {
    const txt = sentinelAlertText([ev(1), ev(2), ev(3)])
    expect(txt).toContain('3')
    // one line per dropped message
    expect(txt.split('\n').filter((l) => l.includes('#')).length).toBe(3)
  })

  it('returns empty string for no escalations (caller sends nothing)', () => {
    expect(sentinelAlertText([])).toBe('')
  })
})
