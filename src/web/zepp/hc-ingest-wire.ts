// WELL-027 AC-3 cross-path parity: the SINGLE anchored source of the ingest WIRE contract --
// the snake_case field names that Path B (hc-transform-node.ts, the n8n Code node) emits and
// Path A (routes/health-ingest.ts) reads back. The two paths are SEQUENTIAL (B produces the
// body, A ingests it), but each historically hardcodes these key strings independently, so a
// rename on either side silently drops a field on the live pipeline while both paths' own
// synthetic tests stay green ("two-synthetic-greens-share-the-assumed-shape" blindspot).
//
// This module does NOT change either hot path (B is a runtime string that cannot import; A's
// many string reads are left as-is to avoid destabilising the ingest handler). Its job is to be
// the ONE place the wire keys are named, anchored to the camelCase ZeppDailySnapshot semantics
// in contract.ts, so the cross-path parity + drift-guard test (zepp-crosspath-parity.test.ts)
// can assert both paths agree against it. If a wire key must change, change it here and the
// drift-guard fails until both paths line up again.

import type { ZeppDailySnapshot, ZeppVitals, ZeppActivity, ZeppWorkout } from './contract.js'

/** Top-level wire keys on the ingest body. */
export const WIRE_TOP = {
  date: 'date',
  syncedAt: 'synced_at',
  vitals: 'vitals',
  sleep: 'sleep',
  workouts: 'workouts',
  activity: 'activity',
} as const

/** vitals.* wire key for each ZeppVitals field Path A maps (mapVitals). */
export const WIRE_VITALS: Record<keyof Pick<ZeppVitals,
  'restingHr' | 'hrv' | 'spo2' | 'breathingRate' | 'skinTemp' | 'hrAvg' | 'hrMin' | 'hrMax'>, string> = {
  restingHr: 'resting_hr_bpm',
  hrv: 'hrv_rmssd_ms',
  spo2: 'spo2_pct',
  breathingRate: 'respiratory_rate_bpm',
  skinTemp: 'skin_temp_c',
  hrAvg: 'hr_avg_bpm',
  hrMin: 'hr_min_bpm',
  hrMax: 'hr_max_bpm',
}

/** activity.* wire keys. `steps` and `caloriesTotal` are read off the activity object by Path A
 *  but land on the TOP-LEVEL snapshot (steps, caloriesTotal), not under activity. */
export const WIRE_ACTIVITY = {
  activeKcal: 'active_kcal',
  distanceM: 'distance_m',
  distanceSlices: 'distance_slices',
  floors: 'floors',
  vo2max: 'vo2max',
  steps: 'steps',
  caloriesTotal: 'total_kcal',
} as const

/** workouts[].* wire keys (buildWorkouts emit vs mapWorkouts read). Note durationMin: the wire
 *  carries whole minutes; Path A multiplies by 60 into durationSec (a documented rounding seam). */
export const WIRE_WORKOUT = {
  type: 'type',
  startAt: 'start',
  durationMin: 'duration_min',
  distanceM: 'distance_m',
  avgHr: 'avg_hr_bpm',
  calories: 'kcal',
} as const

/**
 * The ingest body shape on the wire between Path B and Path A. Additive/documentary: typing a
 * body as HcIngestBody makes a wire-key rename a compile error on any code that opts into it,
 * without forcing the existing handler to adopt it. Values are `unknown`-ish because the raw
 * body is untrusted JSON; the mappers in health-ingest.ts do the bounded coercion.
 */
export interface HcIngestBody {
  date?: string
  synced_at?: string
  vitals?: Record<string, unknown>
  sleep?: unknown
  workouts?: unknown[]
  activity?: Record<string, unknown>
  /** Path A reads heart_rate buckets to derive per-workout avgHr; Path B does NOT forward them
   *  (it consumes them into the vitals aggregate), so a B->A workout has no derived avgHr. */
  heart_rate?: unknown[]
}

/** Fields Path A computes in its server-side finalize chain that Path B legitimately never
 *  emits -- the NAMED, justified cross-path differences (not silent drops). */
export const SERVER_ONLY_FINALIZE_FIELDS: Array<keyof ZeppDailySnapshot> = [
  'pulledAt',
  'status',
]

/** Fields that are absent after a B->A flow because Path B does not carry their wire source --
 *  the NAMED, justified drops (documented, asserted by the parity test). */
export const KNOWN_WIRE_DROPS = {
  /** Path B emits active_calories only; it never emits total_kcal, so caloriesTotal is absent. */
  caloriesTotal: 'B emits no total_kcal (raw total_calories dropped in transform)',
  /** Path B drops skin temperature entirely. */
  'vitals.skinTemp': 'B never emits skin_temp_c',
  /** Path B emits neither avg_hr_bpm nor the heart_rate buckets A would derive it from. */
  'workouts.avgHr': 'B emits no avg_hr_bpm and does not forward heart_rate buckets',
  /** Path B emits no per-workout kcal. */
  'workouts.calories': 'B never emits workout kcal',
} as const

// Referenced so the ZeppActivity/ZeppWorkout imports are used by the anchor's intent even
// though the maps above key on string literals; keeps the contract link explicit for readers.
export type _AnchoredActivity = ZeppActivity
export type _AnchoredWorkout = ZeppWorkout
