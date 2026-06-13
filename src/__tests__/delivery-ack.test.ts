import { describe, it, expect } from 'vitest'
import {
  DELIVERY_PENDING_ACK_SENTINEL,
  shouldWritePendingAck,
  pendingAckRecord,
  parsePendingAckSentinel,
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
