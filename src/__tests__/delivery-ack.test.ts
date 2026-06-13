import { describe, it, expect } from 'vitest'
import {
  DELIVERY_PENDING_ACK_SENTINEL,
  shouldWritePendingAck,
  pendingAckRecord,
  parsePendingAckSentinel,
  ackClearedRecord,
  parseClearedAckIds,
  outstandingPendingAcks,
  selectAcksToClear,
  selectAckEscalations,
  ackEscalationText,
  EMPTY_ACK_CURSOR,
  ACK_ESCALATION_WINDOW_MS,
} from '../web/delivery-ack.js'

// Card 1a99b7e2 WRITE side: a successful inject of an ACK-EXPECTED message
// appends a pending-ack record. The gate is opt-in (ack_expected) so plain FYI
// peer messages are never tracked (no cry-wolf), and the record shape mirrors
// the abandonment sentinel so the d37df625 supervisor consumer reads both.

describe('shouldWritePendingAck', () => {
  it('writes only when ack_expected is truthy', () => {
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b', ack_expected: true })).toBe(true)
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b', ack_expected: 1 })).toBe(true)
  })

  it('does not write for a plain peer message (no flag / falsy)', () => {
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b' })).toBe(false)
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b', ack_expected: false })).toBe(false)
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b', ack_expected: 0 })).toBe(false)
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b', ack_expected: null })).toBe(false)
  })
})

describe('pendingAckRecord', () => {
  it('emits a parseable one-line record with id, parties and delivered_at_ms', () => {
    const rec = JSON.parse(pendingAckRecord({ id: 42, from_agent: 'thor', to_agent: 'dave' }, 1_700_000_000_000))
    expect(rec.event).toBe('delivery-ack-pending')
    expect(rec.id).toBe(42)
    expect(rec.from).toBe('thor')
    expect(rec.to).toBe('dave')
    expect(rec.delivered_at_ms).toBe(1_700_000_000_000)
    expect(rec.ts).toBe(new Date(1_700_000_000_000).toISOString())
  })

  it('is a single line (no embedded newline)', () => {
    expect(pendingAckRecord({ id: 1, from_agent: 'a', to_agent: 'b' }, 0).includes('\n')).toBe(false)
  })
})

describe('parsePendingAckSentinel', () => {
  it('parses well-formed rows and skips blanks/garbage/wrong-event', () => {
    const raw = [
      pendingAckRecord({ id: 1, from_agent: 'a', to_agent: 'b' }, 1000),
      '',
      'not json',
      '{"event":"delivery-abandoned","ts":"x","id":9,"delivered_at_ms":1}', // wrong event
      pendingAckRecord({ id: 2, from_agent: 'c', to_agent: 'b' }, 2000),
      '   ',
    ].join('\n')
    const events = parsePendingAckSentinel(raw)
    expect(events.map((e) => e.id)).toEqual([1, 2])
    expect(events.every((e) => e.event === 'delivery-ack-pending')).toBe(true)
  })

  it('drops rows missing required numeric fields', () => {
    const raw = '{"event":"delivery-ack-pending","ts":"x","id":"notnum","delivered_at_ms":1}'
    expect(parsePendingAckSentinel(raw)).toEqual([])
  })

  it('returns empty for empty input', () => {
    expect(parsePendingAckSentinel('')).toEqual([])
  })
})

describe('DELIVERY_PENDING_ACK_SENTINEL', () => {
  it('lives under the gitignored store/ dir', () => {
    expect(DELIVERY_PENDING_ACK_SENTINEL.startsWith('store/')).toBe(true)
  })
})

// --- CLEAR side (pane-engagement) ------------------------------------------

describe('parsePendingAckSentinel (Chad INFO: from/to typed)', () => {
  it('drops a row missing string from/to', () => {
    const raw = [
      '{"event":"delivery-ack-pending","ts":"x","id":1,"delivered_at_ms":1}', // no from/to
      '{"event":"delivery-ack-pending","ts":"x","id":2,"from":5,"to":"b","delivered_at_ms":1}', // numeric from
      pendingAckRecord({ id: 3, from_agent: 'a', to_agent: 'b' }, 1),
    ].join('\n')
    expect(parsePendingAckSentinel(raw).map((e) => e.id)).toEqual([3])
  })
})

describe('ackClearedRecord', () => {
  it('emits a parseable single-line cleared record', () => {
    const rec = JSON.parse(ackClearedRecord(42, 1_700_000_000_000))
    expect(rec.event).toBe('delivery-ack-cleared')
    expect(rec.id).toBe(42)
    expect(rec.cleared_at_ms).toBe(1_700_000_000_000)
    expect(rec.ts).toBe(new Date(1_700_000_000_000).toISOString())
    expect(ackClearedRecord(1, 0).includes('\n')).toBe(false)
  })
})

describe('parseClearedAckIds', () => {
  it('collects only cleared-event ids, skipping pending/garbage/blank', () => {
    const raw = [
      pendingAckRecord({ id: 1, from_agent: 'a', to_agent: 'b' }, 1000), // pending, not cleared
      ackClearedRecord(1, 2000),
      ackClearedRecord(7, 3000),
      'not json',
      '',
      '{"event":"delivery-ack-cleared","id":"nope"}', // non-numeric id
    ].join('\n')
    const ids = parseClearedAckIds(raw)
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 7])
  })
})

describe('outstandingPendingAcks', () => {
  it('returns pending records with no matching cleared record', () => {
    const raw = [
      pendingAckRecord({ id: 1, from_agent: 'a', to_agent: 'b' }, 1000),
      pendingAckRecord({ id: 2, from_agent: 'c', to_agent: 'd' }, 2000),
      ackClearedRecord(1, 1500), // clears #1
    ].join('\n')
    expect(outstandingPendingAcks(raw).map((e) => e.id)).toEqual([2])
  })

  it('dedupes by id (torn double-write of the same pending row)', () => {
    const raw = [
      pendingAckRecord({ id: 5, from_agent: 'a', to_agent: 'b' }, 1000),
      pendingAckRecord({ id: 5, from_agent: 'a', to_agent: 'b' }, 1000),
    ].join('\n')
    expect(outstandingPendingAcks(raw).map((e) => e.id)).toEqual([5])
  })

  it('is empty when every pending ack is cleared', () => {
    const raw = [
      pendingAckRecord({ id: 1, from_agent: 'a', to_agent: 'b' }, 1000),
      ackClearedRecord(1, 1500),
    ].join('\n')
    expect(outstandingPendingAcks(raw)).toEqual([])
  })
})

describe('selectAcksToClear', () => {
  const out = [
    { ts: 'x', event: 'delivery-ack-pending', id: 1, from: 'a', to: 'dave', delivered_at_ms: 1000 },
    { ts: 'x', event: 'delivery-ack-pending', id: 2, from: 'a', to: 'thor', delivered_at_ms: 1000 },
  ]

  it('clears acks whose recipient is currently busy (engaged)', () => {
    const busy = (to: string) => to === 'dave'
    expect(selectAcksToClear(out, busy, 5000)).toEqual([1])
  })

  it('clears nothing when no recipient is busy', () => {
    expect(selectAcksToClear(out, () => false, 5000)).toEqual([])
  })

  it('never observes before delivery (now <= delivered_at_ms)', () => {
    expect(selectAcksToClear(out, () => true, 1000)).toEqual([])
  })
})

// --- ESCALATE side ----------------------------------------------------------

const ack = (id: number, deliveredAtMs: number, to = 'dave', from = 'thor') => ({
  ts: new Date(deliveredAtMs).toISOString(),
  event: 'delivery-ack-pending',
  id,
  from,
  to,
  delivered_at_ms: deliveredAtMs,
})

describe('selectAckEscalations', () => {
  const NOW = 100 * 60 * 1000 // 100 min in
  const overdue = (id: number) => ack(id, NOW - ACK_ESCALATION_WINDOW_MS - 1) // older than window
  const recent = (id: number) => ack(id, NOW - 60 * 1000) // 1 min old, not overdue

  it('baselines on the first run past all outstanding (escalate nothing)', () => {
    const plan = selectAckEscalations([overdue(10), recent(11)], EMPTY_ACK_CURSOR, NOW)
    expect(plan.baselined).toBe(true)
    expect(plan.escalations).toEqual([])
    expect(plan.nextCursor.lastEscalatedId).toBe(11)
  })

  it('does not baseline on an empty trail', () => {
    const plan = selectAckEscalations([], EMPTY_ACK_CURSOR, NOW)
    expect(plan.baselined).toBe(false)
    expect(plan.escalations).toEqual([])
    expect(plan.nextCursor.lastEscalatedId).toBe(0)
  })

  it('escalates only overdue acks beyond the cursor', () => {
    const plan = selectAckEscalations([overdue(10), recent(11), overdue(12)], { lastEscalatedId: 9 }, NOW)
    expect(plan.escalations.map((e) => e.id)).toEqual([10, 12])
    expect(plan.nextCursor.lastEscalatedId).toBe(12)
  })

  it('does not escalate a not-yet-overdue ack', () => {
    const plan = selectAckEscalations([recent(20)], { lastEscalatedId: 5 }, NOW)
    expect(plan.escalations).toEqual([])
    expect(plan.nextCursor.lastEscalatedId).toBe(5)
  })

  it('caps per run, leaving the remainder for next tick', () => {
    const plan = selectAckEscalations(
      [overdue(13), overdue(14), overdue(15)],
      { lastEscalatedId: 12 },
      NOW,
      { maxPerRun: 2 },
    )
    expect(plan.escalations.map((e) => e.id)).toEqual([13, 14])
    expect(plan.nextCursor.lastEscalatedId).toBe(14)
  })
})

describe('ackEscalationText', () => {
  it('names each overdue ack and reads as a verify-prompt, not a failure', () => {
    const txt = ackEscalationText([ack(42, 0, 'dave', 'thor')])
    expect(txt).toContain('#42')
    expect(txt).toContain('thor')
    expect(txt).toContain('dave')
    expect(txt.toLowerCase()).toContain('not confirmed')
  })

  it('returns empty string for no escalations', () => {
    expect(ackEscalationText([])).toBe('')
  })
})
