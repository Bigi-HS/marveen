// Zepp cloud-pull data contract (WELL-018, fc2992a7).
// Source-agnostic: this shape is what the ingest-store writes and what Hibiki's
// adaptive-plan consumer reads. The pull layer (huami-token + rolandsz exporter)
// populates these fields; the consumer never touches credentials or HTTP.

export type ZeppPullStatus = 'ok' | 'partial' | 'auth_fail' | 'endpoint_error' | 'stale' | 'no_new_data'

export interface ZeppSleep {
  /** Total sleep duration in minutes */
  durationMin: number
  /** Sleep start ISO timestamp */
  startAt: string
  /** Sleep end ISO timestamp */
  endAt: string
  /** Sleep score 0-100 if available */
  score?: number
  /** REM / deep / light / awake breakdown in minutes */
  stages?: {
    rem?: number
    deep?: number
    light?: number
    awake?: number
  }
  /**
   * Daytime naps / secondary sleep sessions, present only when the source recorded
   * more than one session for the day. This object is the main night (the longest
   * session); each nap is a full ZeppSleep with its own duration/stages but never its
   * own nested naps. Boss asked for nap visibility -- previously only the first HC
   * session survived and naps were dropped from the daily aggregate.
   */
  naps?: ZeppSleep[]
}

export interface ZeppVitals {
  /** Resting heart rate bpm */
  restingHr?: number
  /** Blood oxygen %, single measurement */
  spo2?: number
  /** Heart rate variability ms (RMSSD) */
  hrv?: number
  /** Stress score 0-100 (derived from HRV if direct unavailable) */
  stress?: number
  /** Body temperature Celsius */
  skinTemp?: number
  /** Breathing rate breaths/min */
  breathingRate?: number
  /** Day-average heart rate bpm (from HC HeartRate) */
  hrAvg?: number
  /** Day-minimum heart rate bpm */
  hrMin?: number
  /** Day-maximum heart rate bpm */
  hrMax?: number
}

/** One HC distance record for the day: a disjoint ~15-min intraday slice. */
export interface ZeppDistanceSlice {
  /** ISO start timestamp -- the append-only ledger's dedup key (stable across pushes) */
  startAt: string
  /** ISO end timestamp, when the source provided one */
  endAt?: string
  /** Distance metres for this slice */
  meters: number
}

/** Activity / steps summary for the day (HC "Tevekenysegek" category) */
export interface ZeppActivity {
  /** Active calories burned kcal */
  activeKcal?: number
  /**
   * True when activeKcal is implausibly low for the day's steps (card 75337cdc, the raw
   * upstream loss: 5 kcal at 15,790 steps). A LABEL only -- activeKcal itself is never
   * overwritten, because active burn cannot be reliably re-derived from steps alone. The
   * dynamic calorie-goal consumer (Hibiki's '1800 + activeKcal' formula) reads this flag and
   * substitutes its floor estimate instead of building a target off the garbage value. The
   * plausibility Rule 1 DETECTS the same anomaly; this flag carries it onto the stored
   * snapshot for the consumer. Set by applyKcalSuspectLabel; absent when plausible. */
  activeKcalSuspect?: boolean
  /** Distance metres -- the projected sum of distanceSlices when the ledger is present,
   *  otherwise a plain scalar from a legacy/cumulative producer. This is the MEASURED
   *  value and is never overwritten by the step-estimate remediation below. */
  distanceM?: number
  /**
   * Which distance a consumer should surface (WELL-028, Boss-requested remediation).
   * 'measured' -> use distanceM as-is; 'step_estimated' -> the measured distance was
   * implausibly short for the day's steps (the BUG-2 upstream loss), so use
   * estimatedDistanceM and present it AS AN ESTIMATE. An estimate is never shown as a
   * measured number (absence-of-errors discipline). Set by applyDistanceEstimate.
   */
  distanceSource?: 'measured' | 'step_estimated'
  /**
   * Step-derived distance estimate in metres (steps * calibrated stride), populated ONLY
   * when distanceSource === 'step_estimated'. A remediation for the upstream distance loss,
   * kept alongside -- never replacing -- the measured distanceM.
   */
  estimatedDistanceM?: number
  /**
   * Append-only per-day distance ledger (card 75337cdc distance=B). HC distance arrives as
   * disjoint intraday slices, and each push carries only the slices still inside its 48h
   * rolling window; accumulating them here (deduped by startAt) lets distanceM be the true
   * daily sum instead of clobbering down to the last narrow push's subset.
   */
  distanceSlices?: ZeppDistanceSlice[]
  /** Floors climbed */
  floors?: number
  /** VO2max ml/kg/min */
  vo2max?: number
}

export interface ZeppWorkout {
  /** Human-readable workout type (e.g. "running", "other_workout"). Mapped from the
   *  Health Connect ExerciseType code when the source sends a numeric code. */
  type: string
  /** Raw source code, preserved verbatim when the source sent a numeric HC code
   *  (e.g. "0"). Absent when the source already provided a descriptive name. */
  typeCode?: string
  /** ISO start timestamp */
  startAt: string
  /** Duration seconds */
  durationSec: number
  /** Distance metres */
  distanceM?: number
  /** Average heart rate bpm */
  avgHr?: number
  /** Active calories kcal */
  calories?: number
  /** VO2max if recorded */
  vo2max?: number
}

export interface ZeppDailySnapshot {
  /** YYYY-MM-DD local date the snapshot covers */
  date: string
  /** ISO timestamp when the pull or ingest completed */
  pulledAt: string
  /** Outcome of the pull/ingest attempt */
  status: ZeppPullStatus
  sleep?: ZeppSleep
  vitals?: ZeppVitals
  workouts?: ZeppWorkout[]
  /** Activity summary (steps/distance/floors/vo2max) */
  activity?: ZeppActivity
  /** Raw error message when status is not 'ok' */
  error?: string
  /** Steps (top-level shortcut, mirrors activity.steps if present) */
  steps?: number
  /** Total calories burned for the day kcal */
  caloriesTotal?: number
  /** ISO UTC of last device->cloud sync (from HC synced_at) */
  sourceSyncedAt?: string
}
