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

/** Activity / steps summary for the day (HC "Tevekenysegek" category) */
export interface ZeppActivity {
  /** Active calories burned kcal */
  activeKcal?: number
  /** Distance metres */
  distanceM?: number
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
