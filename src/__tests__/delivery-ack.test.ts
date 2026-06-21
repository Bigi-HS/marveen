import { describe, it, expect } from 'vitest'
import {
  DELIVERY_PENDING_ACK_SENTINEL,
  shouldWritePendingAck,
  decidePendingAck,
  pendingAckRecord,
  parsePendingAckSentinel,
  ackClearedRecord,
  parseClearedAckIds,
  outstandingPendingAcks,
  selectAcksToClear,
  selectAckEscalations,
  ackEscalationText,
  compactPendingAckSentinel,
  EMPTY_ACK_CURSOR,
  ACK_ESCALATION_WINDOW_MS,
} from '../web/delivery-ack.js'

// Card 1a99b7e2 WRITE side: a successful inject of an ACK-EXPECTED message
// appends a pending-ack record. The gate is opt-in (ack_expected) so plain FYI
// peer messages are never tracked (no cry-wolf), and the record shape mirrors
// the abandonment sentinel so the d37df625 supervisor consumer reads both.

// Card 0978279f adds the RECIPIENT-capability half of the gate: a pending-ack is
// written ONLY when the sender opted in (ack_expected truthy) AND the recipient
// is ACK-capable. Both halves are required (AND), and the recipient default is
// fail-closed (a recipient not flagged ackCapable is not capable). This keeps a
// cry-wolf out: an ack_expected message to a recipient that can never engage its
// pane (so the clear-observer can never clear it) writes nothing, and the
// d37df625 1h-abandonment net remains the backstop.
describe('shouldWritePendingAck (sender opt-in AND recipient capability)', () => {
  it('writes only when ack_expected is truthy AND recipient is ack-capable', () => {
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b', ack_expected: true }, true)).toBe(true)
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b', ack_expected: 1 }, true)).toBe(true)
  })

  it('does not write when the recipient is not ack-capable, even with ack_expected', () => {
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b', ack_expected: true }, false)).toBe(false)
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b', ack_expected: 1 }, false)).toBe(false)
  })

  it('does not write for a plain peer message (no flag / falsy), regardless of capability', () => {
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b' }, true)).toBe(false)
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b', ack_expected: false }, true)).toBe(false)
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b', ack_expected: 0 }, true)).toBe(false)
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b', ack_expected: null }, true)).toBe(false)
    // and the doubly-negative case
    expect(shouldWritePendingAck({ id: 1, from_agent: 'a', to_agent: 'b', ack_expected: false }, false)).toBe(false)
  })
})

// The three-way decision the router branches on. 'write' appends a pending-ack;
// 'skip-recipient-not-capable' is the OBSERVABILITY case (point b): the sender
// expected an ACK but the recipient cannot confirm, so the router emits a debug
// log rather than leaving a silent expectation gap; 'skip-not-ack-expected' is a
// plain FYI with no expectation at all (no log, no record).
describe('decidePendingAck (router three-way branch, card 0978279f)', () => {
  const msg = { id: 7, from_agent: 'thor', to_agent: 'dave' }

  it('write: ack_expected + capable recipient', () => {
    expect(decidePendingAck({ ...msg, ack_expected: true }, true)).toBe('write')
    expect(decidePendingAck({ ...msg, ack_expected: 1 }, true)).toBe('write')
  })

  it('skip-recipient-not-capable: ack_expected but recipient !capable (observability case)', () => {
    expect(decidePendingAck({ ...msg, ack_expected: true }, false)).toBe('skip-recipient-not-capable')
    expect(decidePendingAck({ ...msg, ack_expected: 1 }, false)).toBe('skip-recipient-not-capable')
  })

  it('skip-not-ack-expected: no opt-in -> no expectation, no log (capability irrelevant)', () => {
    expect(decidePendingAck({ ...msg }, true)).toBe('skip-not-ack-expected')
    expect(decidePendingAck({ ...msg, ack_expected: false }, true)).toBe('skip-not-ack-expected')
    expect(decidePendingAck({ ...msg, ack_expected: 0 }, false)).toBe('skip-not-ack-expected')
    expect(decidePendingAck({ ...msg, ack_expected: null }, false)).toBe('skip-not-ack-expected')
  })

  it('shouldWritePendingAck agrees with decidePendingAck === write across the matrix', () => {
    const acks: Array<boolean | number | null | undefined> = [true, 1, false, 0, null, undefined]
    for (const ack of acks) {
      for (const cap of [true, false]) {
        const m = { ...msg, ack_expected: ack }
        expect(shouldWritePendingAck(m, cap)).toBe(decidePendingAck(m, cap) === 'write')
      }
    }
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

  it('skips already-cleared ids when a clearedIds set is passed (card f7491ad3)', () => {
    const raw = [
      pendingAckRecord({ id: 1, from_agent: 'a', to_agent: 'b' }, 1000),
      pendingAckRecord({ id: 2, from_agent: 'c', to_agent: 'b' }, 2000),
      pendingAckRecord({ id: 3, from_agent: 'd', to_agent: 'b' }, 3000),
    ].join('\n')
    // Without the set, every pending record is returned (original contract).
    expect(parsePendingAckSentinel(raw).map((e) => e.id)).toEqual([1, 2, 3])
    // With the set, cleared ids are dropped during the parse.
    expect(parsePendingAckSentinel(raw, new Set([2])).map((e) => e.id)).toEqual([1, 3])
    expect(parsePendingAckSentinel(raw, new Set([1, 3])).map((e) => e.id)).toEqual([2])
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

// Card 0978279f point c: the capability gate must not create a SECOND scream
// alongside the existing nets (d37df625 1h-abandonment, #146 priority windows).
// The gate only ever REDUCES writes, so it cannot add an escalation path; these
// pin the three interplay cases so a future change can't regress them.
describe('ACK gate x escalation interplay (card 0978279f point c)', () => {
  const NOW_MS = 10_000_000
  const WINDOW = ACK_ESCALATION_WINDOW_MS

  it('capable-but-legit-busy recipient: cleared by engagement, never escalates (no double-scream)', () => {
    // A delegation to a capable recipient that is genuinely busy for a long
    // turn. The pane-engagement observer clears it as soon as it sees busy, so
    // it never reaches the 15-min ACK window -> only one net ever speaks.
    const writeDecision = decidePendingAck({ id: 1, from_agent: 'thor', to_agent: 'dave', ack_expected: true }, true)
    expect(writeDecision).toBe('write')
    const pending = [ack(1, NOW_MS - 60 * 60 * 1000 /* delivered 60min ago */, 'dave', 'thor')]
    const cleared = selectAcksToClear(pending, (to) => to === 'dave' /* busy */, NOW_MS)
    expect(cleared).toEqual([1])
    // With the clear recorded, the outstanding set is empty -> escalation sees nothing.
    const stillOutstanding = pending.filter((p) => !cleared.includes(p.id))
    const plan = selectAckEscalations(stillOutstanding, EMPTY_ACK_CURSOR, NOW_MS, { baselineOnFirstRun: false })
    expect(plan.escalations).toEqual([])
  })

  it('capable-but-WEDGED recipient: never engages -> escalates after the window (the feature, a correct scream)', () => {
    const pending = [ack(2, NOW_MS - (WINDOW + 1000) /* overdue */, 'dave', 'thor')]
    // Wedged: pane never goes busy -> nothing cleared.
    expect(selectAcksToClear(pending, () => false, NOW_MS)).toEqual([])
    const plan = selectAckEscalations(pending, EMPTY_ACK_CURSOR, NOW_MS, { baselineOnFirstRun: false })
    expect(plan.escalations.map((e) => e.id)).toEqual([2])
  })

  it('non-capable recipient: gate skips the write -> never in the pending set -> only the 1h net (single scream possible)', () => {
    // The structural guarantee: a not-capable recipient produces no pending-ack
    // at all, so the ACK escalation path is unreachable for it -- the 15-min
    // ACK net and the 1h abandonment net cannot both fire on the same message.
    const decision = decidePendingAck({ id: 3, from_agent: 'thor', to_agent: 'channelless', ack_expected: true }, false)
    expect(decision).toBe('skip-recipient-not-capable')
    expect(shouldWritePendingAck({ id: 3, from_agent: 'thor', to_agent: 'channelless', ack_expected: true }, false)).toBe(false)
    // Nothing was written, so the escalation consumer has nothing to escalate.
    const plan = selectAckEscalations([], EMPTY_ACK_CURSOR, NOW_MS, { baselineOnFirstRun: false })
    expect(plan.escalations).toEqual([])
  })
})

// Card 681f99b0 (A2): the pending-ack trail is append-only -- a received ack
// leaves a pending+cleared PAIR forever, so the file grows unbounded. The
// boot-fold compacts it to only the records a restart still legitimately owes a
// receipt for: cleared pairs collapse, and an outstanding ack whose message has
// reached a TERMINAL status (done/failed) is reconciled away (done => recipient
// completed => received; failed => abandonment net owns it). Surviving records
// re-serialize losslessly.
describe('compactPendingAckSentinel (A2 boot-fold + DB reconcile)', () => {
  const neverTerminal = () => false

  it('returns empty for an empty / blank trail', () => {
    expect(compactPendingAckSentinel('', neverTerminal)).toBe('')
    expect(compactPendingAckSentinel('\n\n  \n', neverTerminal)).toBe('')
  })

  it('collapses a fully-cleared trail to empty (the dominant growth case)', () => {
    const raw =
      pendingAckRecord({ id: 1, from_agent: 'a', to_agent: 'b' }, 1000) + '\n' +
      pendingAckRecord({ id: 2, from_agent: 'a', to_agent: 'c' }, 1000) + '\n' +
      ackClearedRecord(1, 2000) + '\n' +
      ackClearedRecord(2, 2000) + '\n'
    expect(compactPendingAckSentinel(raw, neverTerminal)).toBe('')
  })

  it('keeps outstanding records and drops the cleared one', () => {
    const raw =
      pendingAckRecord({ id: 1, from_agent: 'a', to_agent: 'b' }, 1000) + '\n' +
      pendingAckRecord({ id: 2, from_agent: 'a', to_agent: 'c' }, 1500) + '\n' +
      ackClearedRecord(1, 2000) + '\n'
    const out = compactPendingAckSentinel(raw, neverTerminal)
    const survivors = parsePendingAckSentinel(out)
    expect(survivors.map((s) => s.id)).toEqual([2])
    // Lossless re-serialization: the surviving record is byte-identical.
    expect(out).toBe(pendingAckRecord({ id: 2, from_agent: 'a', to_agent: 'c' }, 1500) + '\n')
  })

  it('reconciles away an outstanding ack whose message is terminal (done/failed)', () => {
    const raw =
      pendingAckRecord({ id: 10, from_agent: 'a', to_agent: 'b' }, 1000) + '\n' +
      pendingAckRecord({ id: 11, from_agent: 'a', to_agent: 'c' }, 1000) + '\n'
    // id 10 is done (received), id 11 still in flight.
    const out = compactPendingAckSentinel(raw, (id) => id === 10)
    expect(parsePendingAckSentinel(out).map((s) => s.id)).toEqual([11])
  })

  it('ends non-empty output with a newline so a concurrent append cannot merge lines', () => {
    const raw = pendingAckRecord({ id: 7, from_agent: 'a', to_agent: 'b' }, 1000) + '\n'
    const out = compactPendingAckSentinel(raw, neverTerminal)
    expect(out.endsWith('\n')).toBe(true)
    // Appending the next record yields two clean, separately-parseable lines.
    const appended = out + ackClearedRecord(7, 3000) + '\n'
    expect(outstandingPendingAcks(appended)).toEqual([])
  })

  it('skips malformed lines and is idempotent (re-folding a folded trail is a no-op)', () => {
    const raw =
      'not json\n' +
      pendingAckRecord({ id: 5, from_agent: 'x', to_agent: 'y' }, 4000) + '\n' +
      '{"event":"garbage"}\n'
    const once = compactPendingAckSentinel(raw, neverTerminal)
    expect(parsePendingAckSentinel(once).map((s) => s.id)).toEqual([5])
    expect(compactPendingAckSentinel(once, neverTerminal)).toBe(once)
  })
})
