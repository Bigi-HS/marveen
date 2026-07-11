// Analytics label-logic (card 4c81a561, spec store/spec-datagate-b-layer-4c81a561.md
// "Rész 2 -- D1-D3"). Pure functions that translate a RAW metric into a
// RED/GREEN/YELLOW signal. Fixture-testable NOW, zero live token, zero OAuth --
// this is the consent-independent slice of the data-gate B-layer.
//
// HARD RULE (youtube-full discipline "no baked algorithm numbers"): every threshold
// below is an INJECTABLE PARAMETER with a documented default. The LOGIC is durable;
// the NUMBERS are inputs. Callers pass calibrated thresholds -- see the per-run
// calibration note on each default constant. Never treat these defaults as permanent
// platform truth.

import type { YtCtrRow } from './youtube.js'

// ── Signal type ───────────────────────────────────────────────────────────────
// The three-state label the dashboard colours: green (ok), red (flag), grey
// (insufficient_data -- not enough signal to colour either way).
export type MetricLabel = 'insufficient_data' | 'ok' | 'flag'

// The clickbait/session-penalty verdict is its own label so a caller can surface it
// independently of the CTR label (spec D2: "independent of CTR").
export type RetentionLabel = 'insufficient_data' | 'ok' | 'clickbait_flag'

// Long-form vs Shorts. The two formats use DIFFERENT health signals and must never
// share a CTR bucket (spec D3).
export type Format = 'long' | 'short'

// ── Injectable thresholds (documented defaults, NOT baked constants) ────────────

// D1 -- impression floor below which a per-video long-form CTR is statistical noise.
// calibrate per run via date-filtered WebSearch, not a permanent constant.
export const DEFAULT_IMPRESSION_FLOOR = 1000

export interface CtrLabelThresholds {
  // Below this per-video long-form impression count => insufficient_data (D1).
  impressionFloor: number
  // At/above this long-form CTR => 'ok' (green). Below => 'flag' (red). Only applied
  // once the impression floor is cleared. Small-channel-calibrated, devil-advocate
  // cleared -- calibrate per run via date-filtered WebSearch, not a permanent constant.
  ctrOkFloor: number
}

// Default long-form CTR ok-floor. Dubler-hybrid lower band (data-gate PR#354).
// calibrate per run via date-filtered WebSearch, not a permanent constant.
export const DEFAULT_CTR_THRESHOLDS: CtrLabelThresholds = {
  impressionFloor: DEFAULT_IMPRESSION_FLOOR,
  ctrOkFloor: 0.05,
}

export interface ClickbaitThresholds {
  // First-60s retention at/above this = a "hook landed hard" signal (D2 HIGH).
  // calibrate per run via date-filtered WebSearch, not a permanent constant.
  highRetention60s: number
  // If full-video retention falls below (retention60s * dropRatio) the title/thumbnail
  // over-promised and the video did not hold -> clickbait_flag (D2 DROP_RATIO).
  // calibrate per run via date-filtered WebSearch, not a permanent constant.
  dropRatio: number
}

// Default clickbait thresholds. LOGIC is fixed; numbers are per-run inputs.
// calibrate per run via date-filtered WebSearch, not a permanent constant.
export const DEFAULT_CLICKBAIT_THRESHOLDS: ClickbaitThresholds = {
  highRetention60s: 0.7,
  dropRatio: 0.4,
}

export interface ShortsThresholds {
  // At/above this swipe-through rate ("how many chose to view" from the feed swipe)
  // the Shorts first-frame hook is landing -> 'ok'. Below => 'flag'. This is NOT a
  // thumbnail-CTR benchmark (Shorts have no thumbnail-CTR in-feed; spec D3, pulse #2).
  // calibrate per run via date-filtered WebSearch, not a permanent constant.
  swipeThroughOkFloor: number
}

// Default Shorts swipe-through ok-floor. Distinct signal from long-form CTR.
// calibrate per run via date-filtered WebSearch, not a permanent constant.
export const DEFAULT_SHORTS_THRESHOLDS: ShortsThresholds = {
  swipeThroughOkFloor: 0.5,
}

// ── D1: long-form CTR label with insufficient-data floor ────────────────────────

/**
 * D1 -- Long-form per-video CTR label.
 *
 * Below the impression floor the sample is too small to colour either way, so it
 * returns 'insufficient_data' (never a false green/red on a small channel's early
 * videos). At/above the floor it evaluates the CTR against the ok-floor.
 *
 * Thresholds are injected (default DEFAULT_CTR_THRESHOLDS) -- calibrate per run.
 */
export function ctrLabel(
  impressions: number,
  ctr: number,
  thresholds: CtrLabelThresholds = DEFAULT_CTR_THRESHOLDS,
): MetricLabel {
  if (impressions < thresholds.impressionFloor) return 'insufficient_data'
  return ctr >= thresholds.ctrOkFloor ? 'ok' : 'flag'
}

// ── D2: combined clickbait / session-penalty flag ───────────────────────────────

/**
 * D2 -- Clickbait / session-penalty label, INDEPENDENT of CTR.
 *
 * A hook that lands hard (high first-60s retention) but a video that does not hold
 * (full-video retention collapsing below retention60s * dropRatio) is the session-
 * penalty signal: the title/thumbnail over-promised. This is a more important health
 * signal than CTR -- a high-CTR clickbait video still earns this red flag.
 *
 * Returns 'insufficient_data' when a retention input is missing (null), so a video
 * without a measured retention curve is never falsely coloured.
 *
 * Thresholds are injected (default DEFAULT_CLICKBAIT_THRESHOLDS) -- calibrate per run.
 */
export function clickbaitLabel(
  retention60s: number | null,
  retentionFull: number | null,
  thresholds: ClickbaitThresholds = DEFAULT_CLICKBAIT_THRESHOLDS,
): RetentionLabel {
  if (retention60s === null || retentionFull === null) return 'insufficient_data'
  if (
    retention60s >= thresholds.highRetention60s &&
    retentionFull < retention60s * thresholds.dropRatio
  ) {
    return 'clickbait_flag'
  }
  return 'ok'
}

// ── D3: Shorts swipe-through label (NEVER the long-form CTR benchmark) ───────────

/**
 * D3 -- Shorts label. The Shorts feed has NO thumbnail-CTR; the health signal is
 * swipe-through ("how many chose to view") and first-frame hook, NOT thumbnail-CTR.
 * The long-form CTR benchmark must NEVER be applied here.
 *
 * When the pull provides no swipe-through data (null/absent) the Shorts CTR is
 * 'insufficient_data' -- it must NOT fall into the long-form bucket.
 *
 * Thresholds are injected (default DEFAULT_SHORTS_THRESHOLDS) -- calibrate per run.
 */
export function shortsLabel(
  swipeThroughRate: number | null | undefined,
  thresholds: ShortsThresholds = DEFAULT_SHORTS_THRESHOLDS,
): MetricLabel {
  if (swipeThroughRate === null || swipeThroughRate === undefined) return 'insufficient_data'
  return swipeThroughRate >= thresholds.swipeThroughOkFloor ? 'ok' : 'flag'
}

// ── D3 aggregation: keep long-form and Shorts CTR strictly separate ──────────────

// A CTR row may carry a format tag and (for Shorts) a swipe-through rate. Both are
// OPTIONAL so nothing in the existing live-token path changes: a row with no format
// is treated as long-form (backward-compatible with pre-D3 snapshots).
export interface FormatTaggedCtrRow extends YtCtrRow {
  format?: Format
  // Shorts-only feed signal: fraction who chose to view from the feed swipe. Absent
  // on long-form rows and on Shorts rows the pull could not measure.
  swipeThroughRate?: number | null
}

export interface FormatSeparatedCtr {
  // Impression-weighted long-form CTR, or null when no long-form row cleared the
  // impression floor (=> insufficient_data on the dashboard, NOT a mixed value).
  avgCtrLong: number | null
  // Average Shorts swipe-through rate, or null when no Shorts row carried
  // swipe-through data (=> insufficient_data, NEVER folded into the long-form bucket).
  shortsSwipeThrough: number | null
  // Sample sizes so a caller / test can assert the two buckets never cross-contaminate.
  longSampleCount: number
  shortsSampleCount: number
}

/**
 * D3 -- Split CTR rows into two independent buckets and aggregate each separately.
 *
 * Long-form: impression-weighted CTR over rows that clear the impression floor
 * (rows below the floor are excluded from the average -- the D1 insufficient-data
 * rule at the aggregate level). Untagged rows are long-form (backward compatible).
 *
 * Shorts: mean swipe-through over rows that actually carry a swipe-through value.
 * A Shorts row WITHOUT swipe-through contributes to neither bucket -- it can never
 * leak into the long-form CTR average.
 *
 * Returns null for a bucket with no qualifying rows so the dashboard renders
 * 'insufficient_data' rather than a misleading 0 or a cross-format blend.
 *
 * The impression floor is injected (default DEFAULT_IMPRESSION_FLOOR) -- calibrate per run.
 */
export function aggregateCtrByFormat(
  rows: FormatTaggedCtrRow[],
  impressionFloor: number = DEFAULT_IMPRESSION_FLOOR,
): FormatSeparatedCtr {
  const longRows = rows.filter(r => (r.format ?? 'long') === 'long')
  const shortRows = rows.filter(r => r.format === 'short')

  // Long-form: impression-weighted CTR over rows clearing the floor only.
  const qualifyingLong = longRows.filter(r => r.impressions >= impressionFloor)
  const totalImp = qualifyingLong.reduce((a, r) => a + r.impressions, 0)
  const avgCtrLong = totalImp > 0
    ? qualifyingLong.reduce((a, r) => a + r.ctr * r.impressions, 0) / totalImp
    : null

  // Shorts: mean swipe-through over rows that carry the value; absent => excluded.
  const shortsWithSwipe = shortRows.filter(
    (r): r is FormatTaggedCtrRow & { swipeThroughRate: number } =>
      typeof r.swipeThroughRate === 'number',
  )
  const shortsSwipeThrough = shortsWithSwipe.length
    ? shortsWithSwipe.reduce((a, r) => a + r.swipeThroughRate, 0) / shortsWithSwipe.length
    : null

  return {
    avgCtrLong,
    shortsSwipeThrough,
    longSampleCount: qualifyingLong.length,
    shortsSampleCount: shortsWithSwipe.length,
  }
}
