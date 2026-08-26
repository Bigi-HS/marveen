// Numeric plausibility checks for Zepp daily snapshots (card 75337cdc / 351c80a7).
//
// The status/staleness guard (health-guard.ts) proves a pull SUCCEEDED, but not that
// the numbers make physical sense. A broken activity aggregate (e.g. activeKcal=5 at
// 15,790 steps, distance=456m at 15,790 steps -- both seen live 2026-08-25) still reads
// as status 'ok' and would flow straight into Hibiki's goal-calc. These rules ground the
// data in metabolic/biomechanical reality so the system self-catches garbage.
//
// Bounds authored by gauge (health-ingest-plausibility-rules.md). Rules 1/2/4 ship now;
// Rule 3 (distance-vs-workout coherence) and 5/6 are a documented follow-up (WELL card).
// Rollout is LOG-ONLY first (no Telegram/status change) so we can watch the false-
// positive rate for a few days before escalating to a status downgrade.

import type { ZeppDailySnapshot, ZeppVitals, ZeppWorkout } from './contract.js'

export interface PlausibilityViolation {
  rule: string
  severity: 'suspect' | 'warning'
  message: string
}

/**
 * Validate the numeric health metrics of a snapshot. Returns the list of violations
 * (empty = every check passed). Pure: no side effects, no mutation of the input.
 */
export function validateHealthPlausibility(snap: ZeppDailySnapshot): PlausibilityViolation[] {
  const violations: PlausibilityViolation[] = []

  // Rule 1: active calories vs. steps
  if (snap.activity && snap.steps !== undefined) {
    violations.push(...checkKcalStepsRatio(snap.steps, snap.activity.activeKcal))
  }

  // Rule 2: distance vs. steps
  if (snap.activity && snap.steps !== undefined) {
    violations.push(...checkDistanceStepsCoherence(snap.steps, snap.activity.distanceM))
  }

  // Rule 3: activity distance vs workout distance sum coherence
  if (snap.activity && snap.workouts) {
    violations.push(...checkWorkoutDistanceCoherence(snap.activity.distanceM, snap.workouts))
  }

  // Rule 4: heart rate sanity
  if (snap.vitals) {
    violations.push(...checkHeartRateSanity(snap.vitals))
  }

  return violations
}

/** True if any violation is severe enough to mark the snapshot suspect. */
export function hasSuspectViolation(violations: PlausibilityViolation[]): boolean {
  return violations.some((v) => v.severity === 'suspect')
}

/**
 * Rule 1: activeKcal vs. steps.
 * Active burn scales with movement: walking ~0.04-0.06 kcal/step, running up to ~0.15.
 * For >=3,000 steps the daily active kcal should sit in [steps*0.03, steps*0.20]; below
 * 3,000 steps a sedentary day is allowed up to 200 kcal.
 */
function checkKcalStepsRatio(steps: number, activeKcal?: number): PlausibilityViolation[] {
  if (activeKcal === undefined || activeKcal === null) return []
  if (steps < 100) return [] // ignore days with almost no movement

  const violations: PlausibilityViolation[] = []
  const ratio = activeKcal / steps

  if (steps >= 3000) {
    const lowerBound = steps * 0.03
    const upperBound = steps * 0.2
    if (activeKcal < lowerBound || activeKcal > upperBound) {
      violations.push({
        rule: 'activeKcal/steps ratio',
        severity: 'suspect',
        message: `activeKcal ${activeKcal} implausible for ${steps} steps (ratio ${ratio.toFixed(4)}, expected [${lowerBound.toFixed(0)}, ${upperBound.toFixed(0)}])`,
      })
    }
  } else if (activeKcal > 200) {
    // Sedentary day: allow up to 200 kcal for <3k steps
    violations.push({
      rule: 'activeKcal/steps ratio',
      severity: 'suspect',
      message: `activeKcal ${activeKcal} implausible for only ${steps} steps`,
    })
  }

  return violations
}

/**
 * Rule 2: distance vs. steps.
 * Average adult stride is ~0.50-0.90 m/step. For >=3,000 steps the daily distance should
 * sit in [steps*0.50, steps*0.90]; below that a proportional 0.40-1.0 m/step band applies.
 */
function checkDistanceStepsCoherence(steps: number, distanceM?: number): PlausibilityViolation[] {
  if (distanceM === undefined || distanceM === null) return []
  if (steps < 100) return []

  const violations: PlausibilityViolation[] = []
  const ratio = distanceM / steps

  if (steps >= 3000) {
    const lowerBound = steps * 0.5
    const upperBound = steps * 0.9
    if (distanceM < lowerBound || distanceM > upperBound) {
      violations.push({
        rule: 'distance/steps coherence',
        severity: 'suspect',
        message: `distance ${distanceM}m implausible for ${steps} steps (ratio ${ratio.toFixed(3)}, expected [${lowerBound.toFixed(0)}, ${upperBound.toFixed(0)}])`,
      })
    }
  } else if (ratio < 0.4 || ratio > 1.0) {
    violations.push({
      rule: 'distance/steps coherence',
      severity: 'suspect',
      message: `distance ${distanceM}m implausible for ${steps} steps (ratio ${ratio.toFixed(2)})`,
    })
  }

  return violations
}

/**
 * Rule 3: activity.distanceM must be >= sum(workouts.distanceM).
 * Workouts are a subset of daily activity; the day total cannot be less than the workout
 * total (DA C1 anchor: 456m total < 1149m workout sum is physically impossible).
 * Only fires when both sides are present and the workout sum is non-zero.
 */
function checkWorkoutDistanceCoherence(
  distanceM: number | undefined,
  workouts: ZeppWorkout[],
): PlausibilityViolation[] {
  if (distanceM === undefined || workouts.length === 0) return []
  const workoutSum = workouts.reduce((acc, w) => acc + (w.distanceM ?? 0), 0)
  if (workoutSum === 0) return []
  if (distanceM < workoutSum) {
    return [{
      rule: 'workout/activity distance coherence',
      severity: 'suspect',
      message: `activity.distanceM ${distanceM}m < sum(workouts.distanceM) ${workoutSum}m (physically impossible)`,
    }]
  }
  return []
}

/**
 * Rule 4: heart rate sanity.
 * Ordering restingHr < hrAvg < hrMax; reserves hrMax-hrAvg >= 15 and hrAvg-restingHr >= 10;
 * absolute bounds; a flat hrMin==hrMax is a sensor error.
 */
function checkHeartRateSanity(vitals: ZeppVitals): PlausibilityViolation[] {
  const violations: PlausibilityViolation[] = []
  const { restingHr, hrAvg, hrMax, hrMin } = vitals

  if (restingHr !== undefined && hrAvg !== undefined && hrMax !== undefined) {
    if (restingHr >= hrAvg) {
      violations.push({
        rule: 'heart rate ordering',
        severity: 'suspect',
        message: `restingHr ${restingHr} >= hrAvg ${hrAvg} (should be strictly less)`,
      })
    }
    if (hrAvg >= hrMax) {
      violations.push({
        rule: 'heart rate ordering',
        severity: 'suspect',
        message: `hrAvg ${hrAvg} >= hrMax ${hrMax} (should be strictly less)`,
      })
    }
    if (hrMax - hrAvg < 15) {
      violations.push({
        rule: 'heart rate reserve',
        severity: 'warning',
        message: `hrMax ${hrMax} - hrAvg ${hrAvg} = ${hrMax - hrAvg} < 15 (low reserve, flat HR during activity?)`,
      })
    }
    if (hrAvg - restingHr < 10) {
      violations.push({
        rule: 'heart rate reserve',
        severity: 'warning',
        message: `hrAvg ${hrAvg} - restingHr ${restingHr} = ${hrAvg - restingHr} < 10 (minimal elevation)`,
      })
    }
  }

  if (restingHr !== undefined) {
    if (restingHr < 35) {
      violations.push({
        rule: 'heart rate bounds',
        severity: 'suspect',
        message: `restingHr ${restingHr} < 35 (pathologically low without medical reason)`,
      })
    }
    if (restingHr > 120) {
      violations.push({
        rule: 'heart rate bounds',
        severity: 'suspect',
        message: `restingHr ${restingHr} > 120 (implausibly high)`,
      })
    }
  }

  if (hrMax !== undefined) {
    if (hrMax > 220) {
      violations.push({
        rule: 'heart rate bounds',
        severity: 'suspect',
        message: `hrMax ${hrMax} > 220 (age-predicted max for <40y)`,
      })
    }
    if (hrMax < 50) {
      violations.push({
        rule: 'heart rate bounds',
        severity: 'suspect',
        message: `hrMax ${hrMax} < 50 (implausibly low)`,
      })
    }
  }

  if (hrMin !== undefined && hrMax !== undefined && hrMin === hrMax) {
    violations.push({
      rule: 'heart rate flatness',
      severity: 'suspect',
      message: `hrMin ${hrMin} == hrMax ${hrMax} (flat HR during activity suggests sensor error)`,
    })
  }

  return violations
}
