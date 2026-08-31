// activeKcal plausibility label (card 75337cdc, code-side safety-net).
//
// BUG: the measured activeKcal arrives implausibly low for the day's steps (5 kcal at
// 15,790 steps, 2026-08-25), because the upstream transform sums workout-derived
// active_calories rather than the daily Health Connect ActiveCaloriesBurned total -- the
// same cross-field asymmetry that shorts distanceM. Marveen owns the upstream field-map
// fix; this module is the code-side remediation, mirroring distance-estimate.ts.
//
// Unlike distance, active burn CANNOT be re-derived from steps alone (it depends on weight
// and intensity), so we do NOT synthesise a replacement number. Instead we LABEL the value
// suspect and leave the measured activeKcal untouched. The consumer -- Hibiki's dynamic
// calorie goal ('1800 + activeKcal') -- reads the flag and substitutes its floor estimate
// instead of building a target off the garbage value (bug day: 1800 + 5 = 1805 vs the true
// 2811). Hibiki's existing active_kcal_floor only fires on a null activeKcal; this flag
// extends that guard to the implausibly-low case.
//
// Relationship to the plausibility guard (health-plausibility.ts Rule 1): that rule DETECTS
// the same anomaly for the log-only monitor; this module carries the signal onto the stored
// snapshot so the consumer can act on it. Both share isActiveKcalImplausible so the plausible
// band cannot drift between them. Pure and idempotent: a later plausible push drops the flag.

import type { ZeppActivity, ZeppDailySnapshot } from './contract.js'
import { isActiveKcalImplausible } from './health-plausibility.js'

/**
 * Return a copy of `snap` with activity.activeKcalSuspect set when the measured activeKcal is
 * implausibly low for the day's steps, and cleared otherwise. The measured activeKcal is
 * never changed. Pure: the input is not mutated. A snapshot with no activity block is
 * returned unchanged.
 */
export function applyKcalSuspectLabel(snap: ZeppDailySnapshot): ZeppDailySnapshot {
  const activity = snap.activity
  if (!activity) return snap

  const steps = snap.steps
  const suspect = steps !== undefined && isActiveKcalImplausible(steps, activity.activeKcal)

  const nextActivity: ZeppActivity = { ...activity }
  if (suspect) {
    nextActivity.activeKcalSuspect = true
  } else {
    // Drop any stale flag carried forward from a prior push (self-correcting re-eval).
    delete nextActivity.activeKcalSuspect
  }

  return { ...snap, activity: nextActivity }
}

/** The active kcal a goal consumer should use, with whether it was flagged untrustworthy. */
export interface ActiveKcalForGoal {
  kcal?: number
  suspect: boolean
}

/**
 * Report the measured activeKcal alongside the suspect flag, so the dynamic calorie-goal
 * consumer can decline to build a target off a flagged value and fall back to its floor
 * estimate. We deliberately do not return a substitute number -- the fallback policy
 * (Hibiki's floor) belongs to the consumer, not this ingest-side label.
 */
export function activeKcalForGoal(activity: ZeppActivity | undefined): ActiveKcalForGoal {
  if (!activity) return { kcal: undefined, suspect: false }
  return { kcal: activity.activeKcal, suspect: activity.activeKcalSuspect === true }
}
