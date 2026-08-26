// Field-level no-clobber merge for daily Zepp snapshots (WELL-018 AC-A8).
//
// A daily file accumulates across multiple same-date writes. Both ingest paths can
// write a PARTIAL snapshot for a day: Path A (phone push) may send sleep in the
// morning and a workout in the evening as separate deltas; Path B (cloud pull) may
// fail auth and carry no data. A naive full-file overwrite silently wipes whatever an
// earlier write stored. This merge keeps every non-null field a prior write set, so
// partial/empty writes never clobber good data. It is push-mode-agnostic: for a
// cumulative producer it is a near no-op, for a delta producer it is load-bearing --
// the producer's push shape is an unmeasured external claim we must not depend on.
//
// The store's write() stays a dumb full-overwrite (a pinned primitive); this merge is
// applied by the writer via read-modify-write before handing the snapshot to write().

import type { ZeppActivity, ZeppDailySnapshot, ZeppDistanceSlice, ZeppPullStatus } from './contract.js'

// Data + metadata fields carried forward field-by-field. `date`, `pulledAt`, `status`
// and `error` are handled explicitly below, not merged as generic fields. `activity` is
// NOT in this list: it merges sub-field-by-sub-field (with a distance slice-ledger) via
// mergeActivity, so a partial activity push cannot clobber a sibling field or the ledger.
const MERGE_KEYS = [
  'vitals', 'sleep', 'workouts', 'steps', 'caloriesTotal', 'sourceSyncedAt',
] as const

// Statuses that signal a failed pull. They must alert (health-guard) but must not
// downgrade an existing good record when merged onto it.
const ALARM_STATUSES: ReadonlySet<ZeppPullStatus> = new Set(['auth_fail', 'endpoint_error'])

// A field counts as "present" when it carries a value. An explicit null is treated as
// absent (DA refinement): the accumulate-only daily model has no field-delete signal,
// so a null/missing field means "no update", never "erase". An empty array is absent too
// -- `workouts: []` is not a request to clear the stored workouts.
function isPresent(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (Array.isArray(v)) return v.length > 0
  return true
}

// Does a snapshot carry any consumer DATA (not just metadata)? Mirrors the health-ingest
// handler's hasData check; sourceSyncedAt is metadata and does not count toward status.
function hasData(
  s: Pick<ZeppDailySnapshot, 'vitals' | 'sleep' | 'activity' | 'workouts' | 'steps' | 'caloriesTotal'>,
): boolean {
  return isPresent(s.vitals) || isPresent(s.sleep) || isPresent(s.activity) ||
    isPresent(s.workouts) || s.steps !== undefined || s.caloriesTotal !== undefined
}

// Union two distance slice ledgers keyed by startAt (the stable per-slice identity):
// existing slices first, then incoming -- so a repeated slice is deduped and an incoming
// slice CORRECTS a prior value for the same startAt. Sorted by startAt for a stable file.
function unionDistanceSlices(
  prev: ZeppDistanceSlice[] | undefined,
  next: ZeppDistanceSlice[] | undefined,
): ZeppDistanceSlice[] {
  const byStart = new Map<string, ZeppDistanceSlice>()
  for (const s of prev ?? []) byStart.set(s.startAt, s)
  for (const s of next ?? []) byStart.set(s.startAt, s)
  return [...byStart.values()].sort((a, b) => a.startAt.localeCompare(b.startAt))
}

// Merge an incoming activity block onto the existing one. Scalar sub-fields follow the same
// present->replace / absent->keep rule as top-level fields (so a partial activity push does
// not erase a sibling like activeKcal). The distance ledger is accumulated by startAt and
// distanceM is projected as its sum, so a later narrow-window push cannot clobber the total
// down. When no slice ledger is ever present, distanceM stays a plain scalar (legacy path).
function mergeActivity(
  prev: ZeppActivity | undefined,
  next: ZeppActivity | undefined,
): ZeppActivity | undefined {
  if (!next) return prev
  const merged: ZeppActivity = { ...(prev ?? {}) }
  const nextFields = next as unknown as Record<string, unknown>
  const mergedFields = merged as unknown as Record<string, unknown>
  for (const key of Object.keys(nextFields)) {
    if (key === 'distanceSlices' || key === 'distanceM') continue // ledger-projected below
    if (isPresent(nextFields[key])) mergedFields[key] = nextFields[key]
  }
  const slices = unionDistanceSlices(prev?.distanceSlices, next.distanceSlices)
  if (slices.length > 0) {
    merged.distanceSlices = slices
    const ledgerSum = Math.round(slices.reduce((sum, s) => sum + (s.meters || 0), 0))
    // DA-L1 (audit-data-integrity-0826): a prior scalar distanceM with NO slice backing (a
    // legacy write, or a concurrent scalar-only push from the dormant pull path) cannot be
    // deduped against the ledger. Keep the higher of (prior scalar, ledger sum) so the
    // scalar is never silently dropped, without additively double-counting a full-day scalar
    // that already overlaps the incoming tile. Once the ledger exceeds the old scalar, the
    // more precise accumulation wins. Only applies when prev had no slices -- a prev WITH
    // slices already holds a ledger projection, so a legitimate down-correction still lands.
    const priorScalar =
      prev && !isPresent(prev.distanceSlices) && isPresent(prev.distanceM)
        ? (prev.distanceM as number)
        : undefined
    merged.distanceM = priorScalar !== undefined ? Math.max(ledgerSum, priorScalar) : ledgerSum
  } else if (isPresent(next.distanceM)) {
    // No ledger anywhere -> honour the legacy scalar (present->replace).
    merged.distanceM = next.distanceM
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function recomputeStatus(
  existing: ZeppDailySnapshot | null,
  incoming: ZeppDailySnapshot,
  mergedHasData: boolean,
): ZeppPullStatus {
  if (ALARM_STATUSES.has(incoming.status)) {
    // A failed pull must not overwrite a record that already holds good data. Keep the
    // data-status; the failure still surfaces via the alert path (checkSnapshot on the
    // raw pull result), not by corrupting the stored day.
    const existingIsGood = !!existing && (existing.status === 'ok' || hasData(existing))
    if (existingIsGood) return mergedHasData ? 'ok' : 'no_new_data'
    return incoming.status // no prior good record -> surface the failure as-is
  }
  // A `partial` pull that still leaves the merged day with data stays partial (the pull
  // knows a field was missing); a data-carrying non-alarm push is `ok`, an empty one
  // `no_new_data` -- so a bare no_new_data push over an ok record recomputes back to ok.
  if (incoming.status === 'partial') return mergedHasData ? 'partial' : incoming.status
  return mergedHasData ? 'ok' : 'no_new_data'
}

// Merge an incoming daily snapshot onto the existing one for the same date. Returns a new
// object; neither input is mutated. With no existing record the incoming snapshot is
// returned unchanged (first write of the day).
export function mergeDailySnapshot(
  existing: ZeppDailySnapshot | null,
  incoming: ZeppDailySnapshot,
): ZeppDailySnapshot {
  if (!existing) {
    // First write of the day. Still normalize the distance ledger so distanceM is the
    // slice-sum projection (invariant: distanceM always equals sum(distanceSlices) when a
    // ledger is present), even before any accumulation across pushes.
    const activity = mergeActivity(undefined, incoming.activity)
    return activity ? { ...incoming, activity } : incoming
  }

  // Start from the existing record so every field it holds is kept unless the incoming
  // push carries a present replacement.
  const merged: ZeppDailySnapshot = { ...existing, date: incoming.date, pulledAt: incoming.pulledAt }
  const mergedFields = merged as unknown as Record<string, unknown>
  const incomingFields = incoming as unknown as Record<string, unknown>

  for (const key of MERGE_KEYS) {
    const val = incomingFields[key]
    // present -> replace (scalars/objects overwrite, workouts REPLACE the whole array so
    // the own-date + 48h rolling-window dedup is not undone by an append); absent -> keep.
    if (isPresent(val)) {
      mergedFields[key] = val
    }
  }

  // Activity merges sub-field-by-sub-field with an append-only distance ledger (see
  // mergeActivity): the ledger accumulates by startAt and distanceM is its projected sum,
  // so a later narrow rolling-window push cannot clobber the day's distance down.
  const mergedActivity = mergeActivity(existing.activity, incoming.activity)
  if (mergedActivity) merged.activity = mergedActivity
  else delete merged.activity

  merged.status = recomputeStatus(existing, incoming, hasData(merged))

  // Drop a stale error once the day is back to a data status; keep an error only when we
  // actually surface an alarm status (no prior good record to protect).
  if (!ALARM_STATUSES.has(merged.status)) {
    delete merged.error
  } else if (isPresent(incoming.error)) {
    merged.error = incoming.error
  }

  return merged
}
