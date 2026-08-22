// Zepp cloud-pull data contract (WELL-018, fc2992a7).
// Source-agnostic: this shape is what the ingest-store writes and what Hibiki's
// adaptive-plan consumer reads. The pull layer (huami-token + rolandsz exporter)
// populates these fields; the consumer never touches credentials or HTTP.

export type ZeppPullStatus = 'ok' | 'partial' | 'auth_fail' | 'endpoint_error' | 'stale'

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
  /** Heart rate variability ms */
  hrv?: number
  /** Stress score 0-100 (derived from HRV if direct unavailable) */
  stress?: number
  /** Body temperature Celsius */
  skinTemp?: number
  /** Breathing rate breaths/min */
  breathingRate?: number
}

export interface ZeppWorkout {
  /** Workout type string as returned by Zepp (e.g. "outdoor_running") */
  type: string
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
  /** ISO timestamp when the pull completed */
  pulledAt: string
  /** Outcome of the pull attempt */
  status: ZeppPullStatus
  sleep?: ZeppSleep
  vitals?: ZeppVitals
  workouts?: ZeppWorkout[]
  /** Raw error message when status is not 'ok' */
  error?: string
  /** Steps if exposed by the endpoint */
  steps?: number
  /** Total calories burned for the day */
  caloriesTotal?: number
}
