// Static test plan for the append-only health event store (card afd3e654 / WELL-024).
//
// The TS implementation does not exist yet (Boss-GO pending on two-track sequencing).
// This file documents the expected invariants as it.todo() scaffolds so the test suite
// is spec-driven from day one. When `HealthEventStore` lands, replace each `it.todo()`
// with a real test; the fixture shapes here are the starting point.
//
// Spec: store/specs/zepp-well-024-append-only-event-store.md
// Owner: dave (WELL-024); gate: Thor+Chad; avery DIM: regression & coverage lens.
//
// Core model (from spec v2):
//   health_push_receipt: push_id, received_at, category, date, source_synced_at
//   health_event: push_id, category, field, value (per-field rows, or per-instance for arrays)
//   read projection: latest-non-empty-per-category/field, ordered by source_synced_at
//                    (received_at as tiebreaker)
//
// All writes are INSERT-only. No UPDATE or DELETE is ever issued to these tables.

import { describe, it } from 'vitest'

// Placeholder import -- will resolve once implementation lands.
// import { HealthEventStore } from '../web/zepp/health-event-store.js'

describe('append-only health event store (card afd3e654, WELL-024) [static plan]', () => {

  // AC-1: partial evening push does NOT touch the earlier category's data.
  // A workouts-only push must leave the sleep category written by an earlier push unchanged.
  it.todo('AC-1: partial evening workouts push does not remove an earlier sleep category row')

  // AC-2: structural INSERT-only guarantee.
  // Any write to the store must issue only INSERT, never UPDATE or DELETE.
  // Verify by spying on the DB layer and asserting no UPDATE/DELETE calls.
  it.todo('AC-2: every push issues only INSERTs -- no UPDATE or DELETE is ever possible')

  // AC-3: read projection returns latest-non-empty per field (not last-written per push).
  // If push-A sets vitals.restingHr=58 and push-B (later) sets vitals.restingHr=62,
  // the projection must return 62, not 58.
  it.todo('AC-3: read projection returns latest-non-empty field value, not raw row order')

  // AC-4: steps monotone-max -- a later sparse push cannot clobber a higher full-day total.
  // push-A: steps=8000; push-B: steps=12000 (full day); push-C: steps=4000 (window slid).
  // Projection: steps=12000, not 4000.
  it.todo('AC-4: steps monotone-max: a later lower-steps push cannot clobber a prior higher total')

  // AC-5: distance slice ledger dedup by startAt across pushes.
  // push-A: slice T1=105m; push-B: slice T2=435m. Projection: distanceM=540, 2 slices.
  it.todo('AC-5: distance slices accumulate across pushes deduped by startAt (no double-count)')

  // AC-6: commutativity -- merging in different push-receipt order yields the same projection.
  // Fixture from spec: 2026-08-19 (7wk), 2026-08-12 (5wk) golden day data.
  // Inserting in reversed order (latest first) must still produce the correct projection.
  it.todo('AC-6: insert order does not affect read projection (commutativity, golden days 08-19 + 08-12)')

  // AC-7: absorbs WELL-018 Test 6 -- an empty no_new_data push must NOT downgrade a prior ok status.
  // push-A: sleep.durationMin=420, status=ok; push-B: no data, status=no_new_data.
  // Projection: status=ok.
  it.todo('AC-7: empty no_new_data push does not downgrade a prior ok status in the projection')

  // AC-8: audit -- every push is retrievable by push_id with its exact payload.
  // Insert 3 pushes for the same day. listPushesForDate must return 3 rows, each with
  // push_id, received_at, category. getPushById(push_id_A) must return A's exact payload.
  it.todo('AC-8: every push is retrievable by push_id (audit trail, receipt table)')

  // AC-9 (spec v2): late retry with an earlier source_synced_at must NOT regress the projection.
  // push-A: received_at=T1, source_synced_at=S2, vitals.hrv=45 (fresher measurement)
  // push-B: received_at=T2, source_synced_at=S1 (older measurement), vitals.hrv=30
  // Projection ordered by source_synced_at: hrv=45 (S2 wins over S1), NOT 30.
  it.todo('AC-9: late-received push with older source_synced_at does not overwrite a fresher value')

  // DANGEROUS direction pin: verify no-overwrite is structural, not just by convention.
  // An adversarial caller that bypasses the public API and tries to UPDATE a row directly
  // must either be rejected by a DB constraint or cause the read projection to use the
  // latest INSERT (not the UPDATE), preserving the append-only semantics.
  it.todo('[DANGEROUS] direct UPDATE attempt is rejected by DB constraint or ignored by projection')

  // Regression guard: migration from existing daily-*.json files (seed phase).
  // Given a set of daily-*.json files from the old store, the seed migration must produce
  // exactly one push receipt per day and the read projection must match the original JSON.
  it.todo('migration seed: existing daily-*.json seeded into event store yields identical projection')

})
