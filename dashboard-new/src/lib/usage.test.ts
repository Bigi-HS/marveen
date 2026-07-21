import { describe, it, expect } from 'vitest'
import { resetCountdown, clampPct, usageTone } from './usage'

const NOW = 1_700_000_000_000 // fixed epoch ms

describe('resetCountdown', () => {
  it('renders "now" for a past reset', () => {
    expect(resetCountdown(new Date(NOW - 60_000).toISOString(), NOW)).toBe('now')
  })
  it('renders "now" for an unparseable timestamp', () => {
    expect(resetCountdown('not-a-date', NOW)).toBe('now')
  })
  it('renders minutes under an hour', () => {
    expect(resetCountdown(new Date(NOW + 45 * 60_000).toISOString(), NOW)).toBe('in 45m')
  })
  it('renders "in <1m" for a sub-minute reset', () => {
    expect(resetCountdown(new Date(NOW + 30_000).toISOString(), NOW)).toBe('in <1m')
  })
  it('renders hours + minutes under a day', () => {
    expect(resetCountdown(new Date(NOW + (3 * 3600 + 12 * 60) * 1000).toISOString(), NOW)).toBe(
      'in 3h 12m',
    )
  })
  it('renders days + hours for a multi-day reset', () => {
    expect(resetCountdown(new Date(NOW + (4 * 86400 + 2 * 3600) * 1000).toISOString(), NOW)).toBe(
      'in 4d 2h',
    )
  })
})

describe('clampPct', () => {
  it('clamps into 0..100', () => {
    expect(clampPct(-5)).toBe(0)
    expect(clampPct(142)).toBe(100)
    expect(clampPct(42)).toBe(42)
  })
  it('defaults a non-finite value to 0', () => {
    expect(clampPct(NaN)).toBe(0)
    expect(clampPct(Infinity)).toBe(100)
  })
})

describe('usageTone', () => {
  it('is ok below 60', () => {
    expect(usageTone(0)).toBe('ok')
    expect(usageTone(59)).toBe('ok')
  })
  it('is warn in 60..84', () => {
    expect(usageTone(60)).toBe('warn')
    expect(usageTone(84)).toBe('warn')
  })
  it('is alert at 85+', () => {
    expect(usageTone(85)).toBe('alert')
    expect(usageTone(100)).toBe('alert')
  })
})
