import { describe, it, expect } from 'vitest'
import { dayBucket, nowEpochS } from '../db.js'

// dayBucket is the SINGLE SOURCE OF TRUTH for the To-Do widget's daily
// boundary: 03:00 wall-clock Europe/Budapest (DB-AC1/AC2/AC3). 03:00 is chosen
// deliberately OUTSIDE the DST-ambiguous 02:00-03:00 window so the boundary is
// unambiguous on both transition nights. These tests pin the contract; the
// implementation MUST NOT use a fixed UTC offset constant.

// Helper: epoch-seconds of a UTC wall-clock instant.
function utc(y: number, mo: number, d: number, h: number, mi = 0): number {
  return Math.floor(Date.UTC(y, mo - 1, d, h, mi, 0) / 1000)
}

describe('dayBucket — normal summer day (CEST, UTC+2)', () => {
  // 03:00 Budapest CEST on 2025-07-15 == 01:00 UTC 2025-07-15.
  const bucketJul15 = utc(2025, 7, 15, 1) // 01:00 UTC
  const bucketJul14 = utc(2025, 7, 14, 1)

  it('03:01 Budapest (01:01 UTC) belongs to the current bucket', () => {
    expect(dayBucket(utc(2025, 7, 15, 1, 1))).toBe(bucketJul15)
  })

  it('01:30 Budapest (23:30 UTC prev day) belongs to the PREVIOUS bucket', () => {
    // 01:30 CEST Jul 15 == 23:30 UTC Jul 14, which is before 03:00 wall-clock.
    expect(dayBucket(utc(2025, 7, 14, 23, 30))).toBe(bucketJul14)
  })

  it('exactly 03:00 Budapest is inclusive (start of the current bucket)', () => {
    expect(dayBucket(bucketJul15)).toBe(bucketJul15)
  })

  it('is idempotent: dayBucket(dayBucket(x)) == dayBucket(x)', () => {
    const x = utc(2025, 7, 15, 12, 34)
    expect(dayBucket(dayBucket(x))).toBe(dayBucket(x))
  })
})

describe('dayBucket — normal winter day (CET, UTC+1)', () => {
  // 03:00 Budapest CET on 2025-01-15 == 02:00 UTC 2025-01-15.
  const bucketJan15 = utc(2025, 1, 15, 2)
  const bucketJan14 = utc(2025, 1, 14, 2)

  it('03:01 Budapest (02:01 UTC) belongs to the current bucket', () => {
    expect(dayBucket(utc(2025, 1, 15, 2, 1))).toBe(bucketJan15)
  })

  it('01:30 Budapest (00:30 UTC) belongs to the PREVIOUS bucket', () => {
    expect(dayBucket(utc(2025, 1, 15, 0, 30))).toBe(bucketJan14)
  })
})

describe('dayBucket — DST fall-back night (last Sunday October 2025-10-26)', () => {
  // Transition: 03:00 CEST -> 02:00 CET at 01:00 UTC. 03:00 wall-clock Budapest
  // on Oct 26 is in CET (+1) == 02:00 UTC. The previous bucket (Oct 25 03:00) is
  // still CEST (+2) == 01:00 UTC Oct 25.
  const currentBucket = utc(2025, 10, 26, 2) // 03:00 CET == 02:00 UTC
  const previousBucket = utc(2025, 10, 25, 1) // 03:00 CEST == 01:00 UTC

  it('01:30 UTC (02:30 CET, before 03:00 wall-clock) -> PREVIOUS bucket', () => {
    expect(dayBucket(utc(2025, 10, 26, 1, 30))).toBe(previousBucket)
  })

  it('02:30 UTC (03:30 CET, after 03:00 wall-clock) -> CURRENT bucket', () => {
    expect(dayBucket(utc(2025, 10, 26, 2, 30))).toBe(currentBucket)
  })
})

describe('dayBucket — DST spring-forward night (last Sunday March 2025-03-30)', () => {
  // Transition: 02:00 CET -> 03:00 CEST at 01:00 UTC. 03:00 wall-clock Budapest
  // on Mar 30 is in CEST (+2) == 01:00 UTC. The previous bucket (Mar 29 03:00) is
  // still CET (+1) == 02:00 UTC Mar 29.
  const currentBucket = utc(2025, 3, 30, 1) // 03:00 CEST == 01:00 UTC
  const previousBucket = utc(2025, 3, 29, 2) // 03:00 CET == 02:00 UTC

  it('00:30 UTC (01:30 CET, before 03:00 wall-clock) -> PREVIOUS bucket', () => {
    expect(dayBucket(utc(2025, 3, 30, 0, 30))).toBe(previousBucket)
  })

  it('01:30 UTC (03:30 CEST, after 03:00 wall-clock) -> CURRENT bucket', () => {
    expect(dayBucket(utc(2025, 3, 30, 1, 30))).toBe(currentBucket)
  })
})

describe('nowEpochS', () => {
  it('returns integer epoch-seconds close to now', () => {
    const n = nowEpochS()
    expect(Number.isInteger(n)).toBe(true)
    expect(Math.abs(n - Date.now() / 1000)).toBeLessThan(2)
  })
})
