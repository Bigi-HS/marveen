import { describe, it, expect } from 'vitest'
import { relativeTime, truncate, secToMs } from './format'

const NOW = 1_700_000_000_000 // fixed epoch ms

describe('relativeTime', () => {
  it('returns "Never" for null/undefined (AC-F0-3 edge case)', () => {
    expect(relativeTime(null, NOW)).toBe('Never')
    expect(relativeTime(undefined, NOW)).toBe('Never')
  })

  it('returns "just now" under 45s and for future skew', () => {
    expect(relativeTime(NOW, NOW)).toBe('just now')
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now')
    expect(relativeTime(NOW + 60_000, NOW)).toBe('just now')
  })

  it('formats minutes', () => {
    expect(relativeTime(NOW - 2 * 60_000, NOW)).toBe('2m ago')
    expect(relativeTime(NOW - 59 * 60_000, NOW)).toBe('59m ago')
  })

  it('formats hours', () => {
    expect(relativeTime(NOW - 60 * 60_000, NOW)).toBe('1h ago')
    expect(relativeTime(NOW - 23 * 60 * 60_000, NOW)).toBe('23h ago')
  })

  it('formats days', () => {
    expect(relativeTime(NOW - 24 * 60 * 60_000, NOW)).toBe('1d ago')
    expect(relativeTime(NOW - 5 * 24 * 60 * 60_000, NOW)).toBe('5d ago')
  })
})

describe('truncate', () => {
  it('passes short strings through unchanged', () => {
    expect(truncate('hello', 80)).toBe('hello')
    expect(truncate('exact', 5)).toBe('exact')
  })

  it('cuts and appends an ellipsis past the limit', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcde…')
  })

  it('trims trailing whitespace before the ellipsis', () => {
    expect(truncate('abcd efghij', 5)).toBe('abcd…')
  })
})

describe('secToMs', () => {
  it('scales epoch seconds to milliseconds', () => {
    expect(secToMs(1_700_000_000)).toBe(1_700_000_000_000)
  })
})
