import { describe, it, expect } from 'vitest'
import {
  PRIORITY_INT,
  DEFAULT_PRIORITY_INT,
  MESSAGE_PRIORITIES,
  toPriorityInt,
  toPriorityString,
  priorityForColumn,
  columnTypeIsInteger,
  isValidPriorityString,
} from '../priority.js'

// Card 88849f24 (A1->B1 cutover gate): agent_messages.priority migrates from a
// TEXT enum ('low'/'normal'/'high'/'urgent') to INTEGER (25/50/75/100). The
// fleet runs on claudeclaw.db (TEXT) until a separate cutover Boss-GO flips it
// to noa.db (INTEGER), so the delivery code is deployed BEFORE the column type
// changes. priority.ts is the single source of truth that normalizes BOTH
// representations to a canonical integer, making the transition deploy-order
// independent: the same binary is correct against either column type.

describe('PRIORITY_INT canonical map', () => {
  it('maps the four tiers to the spec integers (OQ-4)', () => {
    expect(PRIORITY_INT).toEqual({ low: 25, normal: 50, high: 75, urgent: 100 })
  })

  it('preserves strict tier ordering low < normal < high < urgent', () => {
    expect(PRIORITY_INT.low).toBeLessThan(PRIORITY_INT.normal)
    expect(PRIORITY_INT.normal).toBeLessThan(PRIORITY_INT.high)
    expect(PRIORITY_INT.high).toBeLessThan(PRIORITY_INT.urgent)
  })

  it('defaults to the normal tier', () => {
    expect(DEFAULT_PRIORITY_INT).toBe(PRIORITY_INT.normal)
  })

  it('lists the four tiers low..urgent', () => {
    expect([...MESSAGE_PRIORITIES]).toEqual(['low', 'normal', 'high', 'urgent'])
  })
})

describe('toPriorityInt', () => {
  it('maps each TEXT tier to its canonical integer', () => {
    expect(toPriorityInt('low')).toBe(25)
    expect(toPriorityInt('normal')).toBe(50)
    expect(toPriorityInt('high')).toBe(75)
    expect(toPriorityInt('urgent')).toBe(100)
  })

  it('passes a finite integer through unchanged (post-cutover row)', () => {
    expect(toPriorityInt(25)).toBe(25)
    expect(toPriorityInt(50)).toBe(50)
    expect(toPriorityInt(75)).toBe(75)
    expect(toPriorityInt(100)).toBe(100)
    // arbitrary in-range integers are honoured, not snapped to a tier
    expect(toPriorityInt(80)).toBe(80)
    expect(toPriorityInt(0)).toBe(0)
  })

  it('falls back to the normal default for unknown / null / undefined / NaN', () => {
    expect(toPriorityInt(null)).toBe(DEFAULT_PRIORITY_INT)
    expect(toPriorityInt(undefined)).toBe(DEFAULT_PRIORITY_INT)
    expect(toPriorityInt('bogus' as never)).toBe(DEFAULT_PRIORITY_INT)
    expect(toPriorityInt(Number.NaN)).toBe(DEFAULT_PRIORITY_INT)
    expect(toPriorityInt(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PRIORITY_INT)
  })

  it('round-trips every canonical tier (string -> int)', () => {
    for (const tier of MESSAGE_PRIORITIES) {
      expect(toPriorityInt(tier)).toBe(PRIORITY_INT[tier])
    }
  })
})

describe('toPriorityString', () => {
  it('passes a valid TEXT tier through unchanged', () => {
    expect(toPriorityString('low')).toBe('low')
    expect(toPriorityString('normal')).toBe('normal')
    expect(toPriorityString('high')).toBe('high')
    expect(toPriorityString('urgent')).toBe('urgent')
  })

  it('maps a canonical integer back to its tier (post-cutover row read pre-cutover)', () => {
    expect(toPriorityString(25)).toBe('low')
    expect(toPriorityString(50)).toBe('normal')
    expect(toPriorityString(75)).toBe('high')
    expect(toPriorityString(100)).toBe('urgent')
  })

  it('bucketizes an off-tier integer to the highest tier it reaches', () => {
    expect(toPriorityString(120)).toBe('urgent') // >= urgent
    expect(toPriorityString(90)).toBe('high') // >= high, < urgent
    expect(toPriorityString(60)).toBe('normal') // >= normal, < high
    expect(toPriorityString(10)).toBe('low') // below normal
  })

  it('falls back to normal for unknown / null / undefined', () => {
    expect(toPriorityString(null)).toBe('normal')
    expect(toPriorityString(undefined)).toBe('normal')
    expect(toPriorityString('bogus' as never)).toBe('normal')
  })
})

describe('priorityForColumn (write-side representation match)', () => {
  it('writes an integer when the target column is INTEGER (post-cutover noa.db)', () => {
    expect(priorityForColumn('urgent', true)).toBe(100)
    expect(priorityForColumn(75, true)).toBe(75)
    expect(priorityForColumn(undefined, true)).toBe(DEFAULT_PRIORITY_INT)
  })

  it('writes a TEXT tier when the target column is TEXT (pre-cutover claudeclaw.db, CHECK-safe)', () => {
    expect(priorityForColumn('urgent', false)).toBe('urgent')
    expect(priorityForColumn(100, false)).toBe('urgent')
    expect(priorityForColumn(undefined, false)).toBe('normal')
  })
})

describe('columnTypeIsInteger (PRAGMA table_info declared-type probe)', () => {
  it('detects an INTEGER-affinity declared type', () => {
    expect(columnTypeIsInteger('INTEGER')).toBe(true)
    expect(columnTypeIsInteger('integer')).toBe(true)
    expect(columnTypeIsInteger('INT')).toBe(true)
  })

  it('treats a TEXT declared type as non-integer', () => {
    expect(columnTypeIsInteger('TEXT')).toBe(false)
    expect(columnTypeIsInteger('text')).toBe(false)
  })

  it('treats missing / empty declared type as non-integer (safe default = TEXT)', () => {
    expect(columnTypeIsInteger('')).toBe(false)
    expect(columnTypeIsInteger(null)).toBe(false)
    expect(columnTypeIsInteger(undefined)).toBe(false)
  })
})

describe('isValidPriorityString', () => {
  it('accepts the four tiers and rejects everything else', () => {
    expect(isValidPriorityString('low')).toBe(true)
    expect(isValidPriorityString('urgent')).toBe(true)
    expect(isValidPriorityString('bogus')).toBe(false)
    expect(isValidPriorityString('100')).toBe(false)
    expect(isValidPriorityString('')).toBe(false)
  })
})
