// Per-field reliability tier for Boss-facing health metrics (WELL-027 AC-5/AC-6, card 1677efc9).
//
// The ad-hoc per-field remediations (kcal-suspect.ts, distance-estimate.ts) each answer one
// question about one field. This module unifies them into a single, ordered reliability tier
// carried per Boss-facing field, and -- crucially -- gives derived numbers a rule for how much
// to trust: a derived metric is only as reliable as its WEAKEST input (minTier).
//
// AC-5: every Boss-facing field carries a tier {MEASURED/ADJUSTED/ESTIMATED/UNAVAILABLE},
//   derived from provenance x plausibility x freshness. A render must respect it -- an
//   ESTIMATED/UNAVAILABLE field is never surfaced as a hard measured number (the render side
//   is Hibiki's consumer-gate; this module is the producer that emits the tier).
// AC-6: a derived Boss-facing metric (e.g. the dynamic calorie target 1800 + activeKcal)
//   inherits min(input tiers). The 1800-vs-2811 incident was exactly this: activeKcal arrived
//   UNAVAILABLE (structurally absent / implausible) yet a hard "1805 kcal" target went out as
//   if measured. With min-tier inheritance that derived number is UNAVAILABLE and cannot be
//   surfaced as a hard value.

import type {
  ReliabilityTier,
  ReliabilityTierMap,
  ZeppActivity,
  ZeppDailySnapshot,
} from './contract.js'

// Re-exported so consumers can pull the tier vocabulary from the logic module alongside the
// helpers. The canonical type definition lives in contract.ts (the shared shape module).
export type { ReliabilityTier, ReliabilityTierMap }

// Strongest -> weakest. Higher rank = more trustworthy. UNAVAILABLE is the floor: a field with
// no basis to trust (structurally absent, or present-but-implausible).
const TIER_RANK: Record<ReliabilityTier, number> = {
  MEASURED: 3,
  ADJUSTED: 2,
  ESTIMATED: 1,
  UNAVAILABLE: 0,
}

/**
 * Sort comparator on tier strength: positive when `a` is more reliable than `b`, negative when
 * less, 0 when equal. MEASURED > ADJUSTED > ESTIMATED > UNAVAILABLE.
 */
export function compareTier(a: ReliabilityTier, b: ReliabilityTier): number {
  return TIER_RANK[a] - TIER_RANK[b]
}

/**
 * The weakest of the given tiers -- the core AC-6 rule. With no inputs the result is
 * UNAVAILABLE: a metric derived from nothing has no basis to be trusted.
 */
export function minTier(...tiers: ReliabilityTier[]): ReliabilityTier {
  if (tiers.length === 0) return 'UNAVAILABLE'
  return tiers.reduce((weakest, t) => (compareTier(t, weakest) < 0 ? t : weakest))
}

/**
 * The reliability tier of a DERIVED Boss-facing metric: it can never be more reliable than its
 * weakest input. A dynamic calorie target built from an UNAVAILABLE activeKcal is UNAVAILABLE,
 * never MEASURED (the 1800-vs-2811 structural fix). A thin alias over minTier that names intent
 * at the call site.
 */
export function derivedMetricTier(inputTiers: ReliabilityTier[]): ReliabilityTier {
  return minTier(...inputTiers)
}

/**
 * Reliability tier of the day's activeKcal, from plausibility x provenance:
 *  - structurally absent (Zepp/HC never writes ActiveCaloriesBurned) -> UNAVAILABLE
 *  - present but flagged suspect (implausible for the day's steps) -> UNAVAILABLE
 *  - plausible measured value -> MEASURED
 * activeKcal is never ESTIMATED here: unlike distance it cannot be re-derived from steps alone,
 * so there is no trustworthy estimate to promote it above UNAVAILABLE.
 */
function activeKcalTier(activity: ZeppActivity | undefined): ReliabilityTier {
  if (!activity || activity.activeKcal === undefined || activity.activeKcal === null) return 'UNAVAILABLE'
  if (activity.activeKcalSuspect === true) return 'UNAVAILABLE'
  return 'MEASURED'
}

/**
 * Reliability tier of the day's distance, from the distance-estimate remediation state:
 *  - step_estimated (measured value was implausibly short) -> ESTIMATED
 *  - a present measured value -> MEASURED
 *  - no distance at all -> UNAVAILABLE
 */
function distanceTier(activity: ZeppActivity | undefined): ReliabilityTier {
  if (!activity) return 'UNAVAILABLE'
  if (activity.distanceSource === 'step_estimated' && activity.estimatedDistanceM !== undefined) {
    return 'ESTIMATED'
  }
  if (activity.distanceM !== undefined && activity.distanceM !== null) return 'MEASURED'
  return 'UNAVAILABLE'
}

/**
 * Reliability tier of the day's step count. Present -> MEASURED; absent -> UNAVAILABLE.
 * When a future multi-source step reconciliation lands (the +15% inflation the audit flagged),
 * a provenance marker will downgrade this to ADJUSTED; until such a marker exists on the
 * snapshot, a present count is taken at face value.
 */
function stepsTier(snap: ZeppDailySnapshot): ReliabilityTier {
  return snap.steps !== undefined && snap.steps !== null ? 'MEASURED' : 'UNAVAILABLE'
}

/**
 * Derive the per-field reliability tier map for a snapshot. Pure: no mutation, no side effects.
 * Reads only signals already present on the snapshot (the kcal-suspect / distance-estimate
 * labels + field presence) so it never invents provenance it cannot observe.
 */
export function deriveFieldTiers(snap: ZeppDailySnapshot): ReliabilityTierMap {
  return {
    steps: stepsTier(snap),
    distance: distanceTier(snap.activity),
    activeKcal: activeKcalTier(snap.activity),
  }
}

/**
 * Return a copy of `snap` with the per-field reliability tier map attached under `reliability`.
 * Pure and idempotent: the input is not mutated, and re-running yields the same map (the tiers
 * are a function of the already-finalized field state, not of a prior tier pass). Runs in the
 * write-path finalize chain AFTER the kcal-suspect / distance-estimate labels so it reads the
 * resolved provenance.
 */
export function applyReliabilityTiers(snap: ZeppDailySnapshot): ZeppDailySnapshot {
  return { ...snap, reliability: deriveFieldTiers(snap) }
}
