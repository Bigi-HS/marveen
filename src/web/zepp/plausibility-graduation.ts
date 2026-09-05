// Plausibility rule graduation + block-mode switch (WELL-027 AC-2, card 7888d628).
//
// The four numeric plausibility rules (health-plausibility.ts) currently run LOG-ONLY: a
// suspect verdict becomes a health-guard 'suspect' alert plus an anomaly-store flag, but it
// never STOPS a suspect snapshot from feeding a Boss-facing number. Detection without an
// enforcement path is a silent observer (WELL-027 SPEC-GAP-1/2): "flagged" reads the same as
// "safe". This module closes that with two things the log-only rollout was missing.
//
// 1. A per-rule GRADUATION POLICY -- a measurable promotion criterion (false-positive rate <
//    threshold over N days) with a NAMED owner and a revisit date. The rules are freshly
//    log-only, so there is not yet enough labelled anomaly-flag history to decide a flip; the
//    policy therefore gives an owner + a date to revisit, it does NOT blind-flip now. The
//    FP-rate is measured from the anomaly-store flag history (record()/resolved episodes),
//    so promotion is grounded in data, not opinion.
//
// 2. A BLOCK-MODE SWITCH -- a per-rule mode {log-only | block}. In `block` a rule's suspect
//    verdict routes to the consumer-gate (WELL-027 AC-1): the snapshot is marked BLOCKED so the
//    consumer declines to compute a Boss-facing number from it and falls to its stale/manual
//    branch. In `log-only` (the current default for all four) the same verdict only warns, as
//    today. Flipping one rule to `block` must NOT change the others -- each rule graduates on
//    its own FP evidence.
//
// This is a POLICY + PURE GATE-DECISION module. It reads a snapshot and a mode config and
// returns a decision object; it does NOT itself restart the pull, mutate the stored snapshot,
// or call a consumer. Wiring the returned decision into a specific consumer (Hibiki goal-calc,
// dashboard render) is the AC-1 consumer-gate work and stays out of the fenced ingest path.

import type { ZeppDailySnapshot } from './contract.js'
import {
  validateHealthPlausibility,
  type PlausibilityViolation,
} from './health-plausibility.js'

/** The four live plausibility rules, keyed by a stable id (not the human `rule` string). */
export type PlausibilityRuleId =
  | 'activeKcal-steps' // Rule 1: isActiveKcalImplausible
  | 'distance-steps' // Rule 2: distance-vs-steps coherence
  | 'workout-distance' // Rule 3: activity.distanceM >= sum(workouts.distanceM)
  | 'heart-rate' // Rule 4: heart-rate sanity (ordering / bounds / flatness)

export const PLAUSIBILITY_RULE_IDS: readonly PlausibilityRuleId[] = [
  'activeKcal-steps',
  'distance-steps',
  'workout-distance',
  'heart-rate',
]

/** Per-rule enforcement mode. `log-only` = warn/flag only (today); `block` = route to gate. */
export type RuleMode = 'log-only' | 'block'

/**
 * Map the human-readable `rule` string emitted by health-plausibility.ts onto a stable rule id.
 * Several distinct `rule` strings belong to the same graduation unit (the heart-rate rule emits
 * `heart rate ordering` / `heart rate reserve` / `heart rate bounds` / `heart rate flatness`),
 * so a rename of a message string cannot silently orphan a graduation row.
 */
export function ruleIdForViolation(v: PlausibilityViolation): PlausibilityRuleId | undefined {
  switch (v.rule) {
    case 'activeKcal/steps ratio':
      return 'activeKcal-steps'
    case 'distance/steps coherence':
      return 'distance-steps'
    case 'workout/activity distance coherence':
      return 'workout-distance'
    default:
      return v.rule.startsWith('heart rate') ? 'heart-rate' : undefined
  }
}

/**
 * One rule's graduation policy: the measurable criterion for promoting it from log-only to
 * block, plus who owns that decision and when it is due to be revisited.
 */
export interface GraduationPolicy {
  ruleId: PlausibilityRuleId
  /** Human label for reports. */
  rule: string
  /**
   * Promotion criterion: promote to `block` once the measured false-positive rate over the
   * observation window is at or below this fraction (0..1). A false positive = a suspect
   * episode later judged benign (see FpRateInput).
   */
  fpThreshold: number
  /** Observation window in days over which the FP rate is measured before a flip decision. */
  windowDays: number
  /** Named owner who signs off the flip (not an anonymous auto-flip). */
  owner: string
  /** ISO date (YYYY-MM-DD) to revisit the flip decision with real data. */
  revisitDate: string
  /** Current enforcement mode for this rule. All four ship log-only. */
  mode: RuleMode
}

/**
 * Per-rule graduation table (WELL-027 AC-2). All four rows are fully populated with a
 * measurable FP threshold, an observation window, a NAMED owner, and a revisit date. None of
 * the rules flips now: they are freshly log-only, so the honest state is "collect N days of
 * anomaly-flag data, then the owner revisits on the date below". FP-rate data source =
 * ZeppAnomalyStore flag history (each record()/resolve is one labelled episode).
 *
 * Owners are the fleet agents already accountable for the Zepp integrity line (audit
 * 2026-08-26): gauge authored the plausibility bounds; hibiki is the health-consumer; marveen
 * coordinates. Thresholds start conservative (a rule with strong physical grounding, e.g.
 * workout-distance which is a physical impossibility, tolerates a higher FP bar for promotion
 * because a violation is near-certainly real; the ratio rules start stricter).
 */
export const GRADUATION_TABLE: readonly GraduationPolicy[] = [
  {
    ruleId: 'activeKcal-steps',
    rule: 'activeKcal/steps ratio',
    fpThreshold: 0.05, // <=5% FP over the window
    windowDays: 14,
    owner: 'gauge',
    revisitDate: '2026-09-19',
    mode: 'log-only',
  },
  {
    ruleId: 'distance-steps',
    rule: 'distance/steps coherence',
    fpThreshold: 0.05, // <=5% FP over the window
    windowDays: 14,
    owner: 'gauge',
    revisitDate: '2026-09-19',
    mode: 'log-only',
  },
  {
    ruleId: 'workout-distance',
    rule: 'workout/activity distance coherence',
    // Physically impossible (day total < workout sum) -> a violation is almost never a false
    // positive, so a higher FP tolerance still safely graduates; shorter window to confirm.
    fpThreshold: 0.1, // <=10% FP over the window
    windowDays: 7,
    owner: 'hibiki',
    revisitDate: '2026-09-12',
    mode: 'log-only',
  },
  {
    ruleId: 'heart-rate',
    rule: 'heart rate sanity',
    fpThreshold: 0.05, // <=5% FP over the window
    windowDays: 14,
    owner: 'gauge',
    revisitDate: '2026-09-19',
    mode: 'log-only',
  },
]

/** Look up a rule's graduation policy by id. */
export function graduationPolicyFor(ruleId: PlausibilityRuleId): GraduationPolicy | undefined {
  return GRADUATION_TABLE.find((p) => p.ruleId === ruleId)
}

/**
 * Runtime block-mode configuration: which rules currently enforce (block) vs merely log.
 * Defaults come from the graduation table, so with no override the live behaviour is exactly
 * today's (all four log-only). A flip is an explicit per-rule override -- flipping one rule
 * cannot change any other.
 */
export type PlausibilityModeConfig = Partial<Record<PlausibilityRuleId, RuleMode>>

/** Resolve the effective mode of a rule: an explicit override wins, else the table default. */
export function effectiveMode(
  ruleId: PlausibilityRuleId,
  config?: PlausibilityModeConfig,
): RuleMode {
  const override = config?.[ruleId]
  if (override) return override
  return graduationPolicyFor(ruleId)?.mode ?? 'log-only'
}

/** A single suspect violation carried through the gate, tagged with its rule id + mode. */
export interface GatedViolation {
  ruleId: PlausibilityRuleId
  mode: RuleMode
  violation: PlausibilityViolation
}

/**
 * The gate decision for a snapshot. `blocked` is true when at least one suspect violation
 * belongs to a rule in `block` mode -> the consumer must NOT compute a Boss-facing number from
 * this snapshot and should fall to its stale/manual branch (WELL-027 AC-1). `blocking` lists
 * exactly which rules forced the block; `logOnly` lists the suspect violations whose rule is
 * still log-only (surfaced as a warn/flag, non-blocking). A warning-severity violation never
 * blocks (only 'suspect' can gate).
 */
export interface PlausibilityGateDecision {
  blocked: boolean
  /** Suspect violations from rules in `block` mode -- the reason for the block. */
  blocking: GatedViolation[]
  /** Suspect violations from rules still in `log-only` mode -- warn only, no block. */
  logOnly: GatedViolation[]
}

/**
 * Route a snapshot's suspect verdicts through the per-rule mode switch (WELL-027 AC-1 wiring).
 *
 * Pure: no snapshot mutation, no I/O. In `block` mode a rule's suspect verdict populates
 * `blocking` and sets `blocked=true`; in `log-only` it populates `logOnly` and does not block.
 * With the default config (or none) every rule is log-only, so `blocked` is always false --
 * exactly today's behaviour -- until an owner explicitly flips a rule via `config`.
 */
export function gatePlausibility(
  snap: ZeppDailySnapshot,
  config?: PlausibilityModeConfig,
): PlausibilityGateDecision {
  const suspects = validateHealthPlausibility(snap).filter((v) => v.severity === 'suspect')

  const blocking: GatedViolation[] = []
  const logOnly: GatedViolation[] = []

  for (const violation of suspects) {
    const ruleId = ruleIdForViolation(violation)
    if (!ruleId) continue // unknown rule string -> not gated (fail-open on classification only)
    const mode = effectiveMode(ruleId, config)
    const gated: GatedViolation = { ruleId, mode, violation }
    if (mode === 'block') blocking.push(gated)
    else logOnly.push(gated)
  }

  return { blocked: blocking.length > 0, blocking, logOnly }
}

/**
 * A measured false-positive observation for one rule over the graduation window. Sourced from
 * the anomaly-store flag history: `episodes` = suspect episodes the rule opened in the window;
 * `falsePositives` = how many of those were later judged benign (auto-resolved by a clean
 * push with no operator confirmation, or explicitly marked FP by the owner). The caller reads
 * these off ZeppAnomalyStore.list() (per-day flags, detectedAt..resolvedAt) so the promotion
 * decision is grounded in real recorded data rather than a hand-wave.
 */
export interface FpRateInput {
  ruleId: PlausibilityRuleId
  episodes: number
  falsePositives: number
}

/** Measured FP rate (0..1) for a rule; 0 episodes -> undefined (not enough data to judge). */
export function measuredFpRate(input: FpRateInput): number | undefined {
  if (input.episodes <= 0) return undefined
  return input.falsePositives / input.episodes
}

/**
 * Is a rule READY to be promoted to block mode? True only when there is enough data (episodes
 * covering the policy window's expectation) AND the measured FP rate is at or below the
 * policy's threshold. With zero episodes it returns false -- the honest "not enough data yet"
 * state that keeps the rule log-only until its revisit date. This is the measurable criterion;
 * the actual flip is still an owner decision (flip the mode in PlausibilityModeConfig).
 */
export function isReadyForBlockPromotion(input: FpRateInput): boolean {
  const policy = graduationPolicyFor(input.ruleId)
  if (!policy) return false
  const rate = measuredFpRate(input)
  if (rate === undefined) return false // no episodes -> cannot judge -> stay log-only
  return rate <= policy.fpThreshold
}
