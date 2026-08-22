/**
 * D1-D3 label-logic tests (card 4c81a561, spec store/spec-datagate-b-layer-4c81a561.md
 * "Rész 2 -- D1-D3"). Pure functions over fixtures -- no live token, no network,
 * no OAuth. Assertions target the actual boundary behaviour (mutation-meaningful),
 * not truthiness.
 */
import { describe, it, expect } from 'vitest'

import {
  ctrLabel,
  clickbaitLabel,
  shortsLabel,
  aggregateCtrByFormat,
  DEFAULT_IMPRESSION_FLOOR,
  DEFAULT_CTR_THRESHOLDS,
  DEFAULT_CLICKBAIT_THRESHOLDS,
  DEFAULT_SHORTS_THRESHOLDS,
  type FormatTaggedCtrRow,
} from '../analytics/labels.js'

describe('D1 -- ctrLabel insufficient-data floor', () => {
  it('returns insufficient_data below the impression floor (no green/red)', () => {
    // One impression under the floor => grey, regardless of a strong CTR.
    expect(ctrLabel(DEFAULT_IMPRESSION_FLOOR - 1, 0.9)).toBe('insufficient_data')
    expect(ctrLabel(0, 0.9)).toBe('insufficient_data')
  })

  it('evaluates ok/flag at and above the floor', () => {
    // Exactly at the floor is enough signal (boundary is inclusive).
    expect(ctrLabel(DEFAULT_IMPRESSION_FLOOR, DEFAULT_CTR_THRESHOLDS.ctrOkFloor)).toBe('ok')
    // Above floor, CTR under the ok-floor => flag (red).
    expect(ctrLabel(5000, DEFAULT_CTR_THRESHOLDS.ctrOkFloor - 0.001)).toBe('flag')
    // Above floor, CTR at/over ok-floor => ok (green).
    expect(ctrLabel(5000, DEFAULT_CTR_THRESHOLDS.ctrOkFloor + 0.02)).toBe('ok')
  })

  it('honours an injected floor rather than a baked constant', () => {
    // With a custom floor of 200, 500 impressions now clears it.
    expect(ctrLabel(500, 0.06, { impressionFloor: 200, ctrOkFloor: 0.05 })).toBe('ok')
    // ...and 150 does not.
    expect(ctrLabel(150, 0.06, { impressionFloor: 200, ctrOkFloor: 0.05 })).toBe('insufficient_data')
  })
})

describe('D2 -- clickbaitLabel combined session-penalty flag', () => {
  const t = DEFAULT_CLICKBAIT_THRESHOLDS

  it('flags high 60s retention + collapsing full retention, independent of CTR', () => {
    // 0.85 first-60s (>= HIGH 0.7) and 0.20 full (< 0.85*0.4 = 0.34) => clickbait.
    expect(clickbaitLabel(0.85, 0.2)).toBe('clickbait_flag')
  })

  it('does NOT flag when the video holds retention', () => {
    // High hook but full-video retention stays above the drop line => ok.
    expect(clickbaitLabel(0.85, 0.5)).toBe('ok')
  })

  it('does NOT flag when the hook never landed hard (60s below HIGH)', () => {
    // Even a big drop is not the clickbait signal without a hard hook.
    expect(clickbaitLabel(t.highRetention60s - 0.01, 0.05)).toBe('ok')
  })

  it('is exactly at the drop boundary => not a flag (strict <)', () => {
    // full === retention60s * dropRatio is NOT below it, so no flag.
    const full = 0.8 * t.dropRatio
    expect(clickbaitLabel(0.8, full)).toBe('ok')
    // A hair below the same boundary DOES flag.
    expect(clickbaitLabel(0.8, full - 0.0001)).toBe('clickbait_flag')
  })

  it('returns insufficient_data when a retention input is missing', () => {
    expect(clickbaitLabel(null, 0.2)).toBe('insufficient_data')
    expect(clickbaitLabel(0.85, null)).toBe('insufficient_data')
  })

  it('honours injected thresholds', () => {
    // Loosen HIGH to 0.5 and dropRatio to 0.9: 0.6/0.4 now flags.
    expect(clickbaitLabel(0.6, 0.4, { highRetention60s: 0.5, dropRatio: 0.9 })).toBe('clickbait_flag')
    // Same inputs with the strict default => not a flag.
    expect(clickbaitLabel(0.6, 0.4)).toBe('ok')
  })
})

describe('D3 -- shortsLabel (never the long-form CTR benchmark)', () => {
  it('returns insufficient_data when swipe-through is absent (null/undefined)', () => {
    expect(shortsLabel(null)).toBe('insufficient_data')
    expect(shortsLabel(undefined)).toBe('insufficient_data')
  })

  it('labels ok/flag against the swipe-through floor, not a thumbnail-CTR band', () => {
    const floor = DEFAULT_SHORTS_THRESHOLDS.swipeThroughOkFloor
    expect(shortsLabel(floor)).toBe('ok')          // inclusive boundary
    expect(shortsLabel(floor - 0.01)).toBe('flag')
    // A value that would be an ELITE long-form CTR (0.09) is a FAILING swipe-through:
    // proves the Shorts label does not reuse the long-form band.
    expect(shortsLabel(0.09)).toBe('flag')
  })
})

describe('D3 -- aggregateCtrByFormat long vs short separation', () => {
  it('keeps long-form and Shorts CTR in separate buckets', () => {
    const rows: FormatTaggedCtrRow[] = [
      { videoId: 'L1', impressions: 10000, ctr: 0.06, format: 'long' },
      { videoId: 'L2', impressions: 20000, ctr: 0.04, format: 'long' },
      { videoId: 'S1', impressions: 50000, ctr: 0, format: 'short', swipeThroughRate: 0.7 },
      { videoId: 'S2', impressions: 30000, ctr: 0, format: 'short', swipeThroughRate: 0.5 },
    ]
    const out = aggregateCtrByFormat(rows)

    // Long-form: impression-weighted (0.06*10000 + 0.04*20000)/30000 = 0.046667.
    expect(out.avgCtrLong).toBeCloseTo(0.0466667, 5)
    expect(out.longSampleCount).toBe(2)

    // Shorts: mean swipe-through (0.7 + 0.5)/2 = 0.6, NOT mixed with long-form CTR.
    expect(out.shortsSwipeThrough).toBeCloseTo(0.6, 5)
    expect(out.shortsSampleCount).toBe(2)
  })

  it('treats untagged rows as long-form (backward compatible with pre-D3 snapshots)', () => {
    const rows: FormatTaggedCtrRow[] = [
      { videoId: 'v1', impressions: 12000, ctr: 0.05 },
      { videoId: 'v2', impressions: 8000, ctr: 0.07 },
    ]
    const out = aggregateCtrByFormat(rows)
    expect(out.longSampleCount).toBe(2)
    expect(out.shortsSampleCount).toBe(0)
    expect(out.shortsSwipeThrough).toBeNull()
  })

  it('Shorts row WITHOUT swipe-through => insufficient_data, never in the long-form bucket', () => {
    const rows: FormatTaggedCtrRow[] = [
      { videoId: 'L1', impressions: 10000, ctr: 0.05, format: 'long' },
      { videoId: 'S1', impressions: 40000, ctr: 0.9, format: 'short' }, // no swipeThroughRate
    ]
    const out = aggregateCtrByFormat(rows)
    // Shorts bucket empty => null (insufficient_data), NOT the 0.9 leaking anywhere.
    expect(out.shortsSwipeThrough).toBeNull()
    expect(out.shortsSampleCount).toBe(0)
    // Long-form bucket is exactly the one long row -- the Shorts ctr=0.9 did not blend in.
    expect(out.avgCtrLong).toBeCloseTo(0.05, 5)
    expect(out.longSampleCount).toBe(1)
  })

  it('excludes below-floor long-form rows; null when none qualify (D1 at aggregate level)', () => {
    const rows: FormatTaggedCtrRow[] = [
      { videoId: 'small', impressions: DEFAULT_IMPRESSION_FLOOR - 1, ctr: 0.9, format: 'long' },
    ]
    const out = aggregateCtrByFormat(rows)
    expect(out.avgCtrLong).toBeNull()
    expect(out.longSampleCount).toBe(0)
  })

  it('honours an injected impression floor', () => {
    const rows: FormatTaggedCtrRow[] = [
      { videoId: 'a', impressions: 300, ctr: 0.06, format: 'long' },
    ]
    // Default floor (1000) excludes the row => null.
    expect(aggregateCtrByFormat(rows).avgCtrLong).toBeNull()
    // Injected floor of 200 includes it.
    expect(aggregateCtrByFormat(rows, 200).avgCtrLong).toBeCloseTo(0.06, 5)
  })
})
