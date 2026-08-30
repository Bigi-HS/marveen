// Shared validated write funnel for Zepp daily snapshots (WELL-027 WS1).
//
// Every writer (push ingest AND pull/backfill) must persist a snapshot through THIS one
// function so an implausible day surfaces as a queryable anomaly flag -- not merely an
// ephemeral log line. Historically only the push path (health-ingest.ts) recorded anomalies;
// the pull path (pull-runner.ts) wrote via the store and logged an alert but never persisted
// the flag. That is the guard-only-as-good-as-its-wiring gap: a Boss-facing anomaly count
// silently missed any violation on a non-push write. Routing both paths through one funnel
// makes it structurally impossible for a writer to skip the anomaly record.
//
// Note Rule 4 (heart-rate sanity) fires on `vitals` -- a field the pull path writes -- so this
// is a live gap, not a latent one: an implausible vitals pull would previously go unflagged.

import type { ZeppDailySnapshot } from './contract.js'
import { validateHealthPlausibility, type PlausibilityViolation } from './health-plausibility.js'

export interface ValidatedIngestDeps {
  writeSnapshot: (snap: ZeppDailySnapshot) => void
  recordAnomaly: (date: string, suspect: PlausibilityViolation[]) => void
}

/**
 * Persist a snapshot and its plausibility anomaly flag in one step.
 *
 * Writes the snapshot FIRST (the durable record never depends on the anomaly write), then
 * validates it and records the suspect-severity violations. An empty suspect list is passed
 * through deliberately: the anomaly store resolves an open flag when a later clean write
 * reports no suspect rule (self-correcting, mirroring the push path).
 *
 * Returns ALL violations (suspect + warning) so a caller can additionally log or alert without
 * re-validating.
 */
export function writeValidatedSnapshot(
  snap: ZeppDailySnapshot,
  deps: ValidatedIngestDeps,
): PlausibilityViolation[] {
  deps.writeSnapshot(snap)
  const violations = validateHealthPlausibility(snap)
  deps.recordAnomaly(snap.date, violations.filter((v) => v.severity === 'suspect'))
  return violations
}
