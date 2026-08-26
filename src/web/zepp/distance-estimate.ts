// Step-derived distance estimate (WELL-028 / WELL-026, Boss-requested remediation).
//
// BUG-2: the measured HC distance arrives implausibly short for the day's steps (456 m at
// 15,790 steps, 2026-08-25), because the upstream producer (Zepp->HC write or the phone HC
// read) drops most Distance records while steps survive. We cannot fix that on the push
// side, so instead of surfacing a broken number we DERIVE a distance estimate from steps
// and a calibrated stride, and label it so it is never presented as a measured value.
//
// Relationship to the plausibility guard (health-plausibility.ts Rule 2): that rule DETECTS
// the same low distance/steps anomaly (the G3 cross-field invariant). This module is the
// REMEDIATION -- detection plus a labelled fallback in one step. It never mutates the
// measured distanceM/distanceSlices; it only sets distanceSource and (when triggered)
// estimatedDistanceM. Pure and idempotent: re-running on a later push that carries real
// distance drops the stale estimate and flips the label back to 'measured'.

import type { ZeppActivity, ZeppDailySnapshot } from './contract.js'

// Calibrated from Boss's known-good day (distanceM 12040 / steps 15790 = 0.7625 m/step),
// which is also a typical adult walking stride. Calibratable via the strideM option so a
// future per-user calibration (averaging several known days) can refine it without a code
// change.
export const DEFAULT_STRIDE_M = 0.762

// Trigger threshold: a measured distance below steps * this ratio is implausibly short (a
// person covers well over 0.4 m per step when walking), so the measured value is treated as
// incomplete and the estimate is surfaced instead. Matches the low bound of plausibility
// Rule 2 (checkDistanceStepsCoherence).
export const LOW_DISTANCE_RATIO = 0.4

// Below this many steps the distance shortfall is immaterial and a near-zero distance is
// physically plausible (a mostly-sedentary day), so we never estimate -- estimating there
// would only add noise.
export const MIN_STEPS_FOR_ESTIMATE = 1000

export interface DistanceEstimateOptions {
  /** Metres per step; defaults to DEFAULT_STRIDE_M. */
  strideM?: number
}

/**
 * Return a copy of `snap` with activity.distanceSource labelled and, when the measured
 * distance is implausibly short for the day's steps, activity.estimatedDistanceM populated.
 * The measured distanceM and distanceSlices are never changed. Pure: the input is not
 * mutated. A snapshot with no activity block is returned unchanged.
 */
export function applyDistanceEstimate(
  snap: ZeppDailySnapshot,
  opts: DistanceEstimateOptions = {},
): ZeppDailySnapshot {
  const activity = snap.activity
  if (!activity) return snap

  const steps = snap.steps
  const measured = activity.distanceM
  const strideM = opts.strideM ?? DEFAULT_STRIDE_M

  const canEstimate = steps !== undefined && steps >= MIN_STEPS_FOR_ESTIMATE
  const distanceTooShort = measured === undefined || measured < steps! * LOW_DISTANCE_RATIO

  const nextActivity: ZeppActivity = { ...activity }
  if (canEstimate && distanceTooShort) {
    nextActivity.distanceSource = 'step_estimated'
    nextActivity.estimatedDistanceM = Math.round(steps! * strideM)
  } else {
    nextActivity.distanceSource = 'measured'
    // Drop any stale estimate carried forward from a prior push (self-correcting re-eval).
    delete nextActivity.estimatedDistanceM
  }

  return { ...snap, activity: nextActivity }
}

/** The distance a consumer should show, with which kind it is. */
export interface DistanceForDisplay {
  meters: number
  source: 'measured' | 'step_estimated'
}

/**
 * Pick the distance to surface to the user: the step-estimate when the measured value was
 * flagged too short, otherwise the measured value. Returns undefined when there is no
 * distance to show. The caller formats km + a localized label ("~12 km (becsult, lepesbol)"
 * for an estimate); this keeps the choice-of-number logic in one tested place.
 */
export function distanceForDisplay(
  activity: ZeppActivity | undefined,
): DistanceForDisplay | undefined {
  if (!activity) return undefined
  if (activity.distanceSource === 'step_estimated' && activity.estimatedDistanceM !== undefined) {
    return { meters: activity.estimatedDistanceM, source: 'step_estimated' }
  }
  if (activity.distanceM !== undefined) {
    return { meters: activity.distanceM, source: 'measured' }
  }
  return undefined
}
