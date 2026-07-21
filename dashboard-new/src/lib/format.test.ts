import { describe, it, expect } from 'vitest'
import { relativeTime, truncate, secToMs } from './format'

const NOW = 1_700_000_000_000 // fixed epoch ms

describe('relativeTime (Hungarian microcopy)', () => {
  it('returns "Soha" for null/undefined (AC-F0-3 edge case)', () => {
    expect(relativeTime(null, NOW)).toBe('Soha')
    expect(relativeTime(undefined, NOW)).toBe('Soha')
  })

  it('returns "most" under 45s and for future skew', () => {
    expect(relativeTime(NOW, NOW)).toBe('most')
    expect(relativeTime(NOW - 10_000, NOW)).toBe('most')
    expect(relativeTime(NOW + 60_000, NOW)).toBe('most')
  })

  it('formats minutes', () => {
    expect(relativeTime(NOW - 2 * 60_000, NOW)).toBe('2 perce')
    expect(relativeTime(NOW - 59 * 60_000, NOW)).toBe('59 perce')
  })

  it('formats hours', () => {
    expect(relativeTime(NOW - 60 * 60_000, NOW)).toBe('1 órája')
    expect(relativeTime(NOW - 23 * 60 * 60_000, NOW)).toBe('23 órája')
  })

  it('formats days', () => {
    expect(relativeTime(NOW - 24 * 60 * 60_000, NOW)).toBe('1 napja')
    expect(relativeTime(NOW - 5 * 24 * 60 * 60_000, NOW)).toBe('5 napja')
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
