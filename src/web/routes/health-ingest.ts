// POST /api/health/ingest -- Health Connect push ingress (WELL-018 Path A).
// Phone automation (Automate / HTTP Shortcuts) POSTs HC data once per schedule.
// Auth: X-Ingest-Token header (dedicated secret, distinct from dashboard bearer).
// The endpoint is public via Cloudflare tunnel -> the token gate is load-bearing.
//
// Idempotency: same-date overwrites (last-write-wins). The phone may push several
// times per day (sleep in morning, activity in evening); each overwrites the file.
// Silent-guard: always writes a snapshot -- an empty or failed push is visible.

import { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { readBody, RequestBodyTooLargeError, json } from '../http-helpers.js'
import { defaultZeppStore } from '../zepp/ingest-store.js'
import { readIngestToken } from '../zepp/ingest-secret.js'
import type {
  ZeppDailySnapshot, ZeppVitals, ZeppSleep, ZeppWorkout, ZeppActivity, ZeppPullStatus,
} from '../zepp/contract.js'
import type { RouteContext } from './types.js'

// HC daily payloads are small structured JSON (vitals/sleep/activity). Cap the
// read well below the generic default: the endpoint is public via the Cloudflare
// tunnel, so an unbounded body is a memory-exhaustion surface (chad FLAG medium).
const MAX_INGEST_BYTES = 64 * 1024

// Constant-time secret comparison so the token gate does not leak byte-position
// via response timing (chad INFO low). Length is compared first (a length leak is
// standard and unavoidable with fixed-time compare); the bytes are compared in
// constant time.
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export interface HealthIngestDeps {
  readIngestToken: () => string
  writeSnapshot: (snap: ZeppDailySnapshot) => void
  nowIso: () => string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function mapVitals(v: Record<string, unknown>): ZeppVitals {
  return {
    restingHr: num(v['resting_hr_bpm']),
    hrv: num(v['hrv_rmssd_ms']),
    spo2: num(v['spo2_pct']),
    breathingRate: num(v['respiratory_rate_bpm']),
    skinTemp: num(v['skin_temp_c']),
    hrAvg: num(v['hr_avg_bpm']),
    hrMin: num(v['hr_min_bpm']),
    hrMax: num(v['hr_max_bpm']),
  }
}

// Map one HC sleep session into a ZeppSleep (no nested naps).
function mapSleepSession(s: Record<string, unknown>): ZeppSleep {
  const totalMin = num(s['total_min']) ?? 0
  const raw = s['stages'] as Record<string, unknown> | undefined
  const stages = raw
    ? {
        deep: num(raw['deep_min']),
        light: num(raw['light_min']),
        rem: num(raw['rem_min']),
        awake: num(raw['awake_min']),
      }
    : undefined
  return {
    durationMin: totalMin,
    startAt: str(s['start']) ?? (str(s['date']) + 'T00:00:00Z'),
    endAt: str(s['end']) ?? (str(s['date']) + 'T08:00:00Z'),
    ...(stages && { stages }),
  }
}

// Reduce an HC sleep-session list to a single ZeppSleep: the main night is the
// longest session, and every other session surfaces as a nap (ordered by start time).
// The transform forwards ALL sessions as an array; folding to sleep[0] here would drop
// the naps Boss asked to see. Returns undefined for an empty list.
function mapSleepList(list: unknown[]): ZeppSleep | undefined {
  const sessions = list
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map(mapSleepSession)
  if (sessions.length === 0) return undefined
  // Longest = main night. Stable pick: the first max by duration keeps the source order
  // among equal-length sessions.
  let mainIdx = 0
  for (let i = 1; i < sessions.length; i++) {
    if (sessions[i].durationMin > sessions[mainIdx].durationMin) mainIdx = i
  }
  const main = sessions[mainIdx]
  const naps = sessions
    .filter((_, i) => i !== mainIdx)
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
  return naps.length > 0 ? { ...main, naps } : main
}

function mapActivity(a: Record<string, unknown>): ZeppActivity {
  return {
    activeKcal: num(a['active_kcal']),
    distanceM: num(a['distance_m']),
    floors: num(a['floors']),
    vo2max: num(a['vo2max']),
  }
}

// Health Connect ExerciseSessionRecord.exerciseType integer codes -> readable names.
// The zepp-hc pipeline forwards the raw HC code; we resolve it to a name here (tested,
// gated) rather than in the untested n8n transform. Code 0 = OTHER_WORKOUT.
// Source: androidx.health.connect.client.records.ExerciseSessionRecord.
const EXERCISE_TYPE_NAMES: Record<string, string> = {
  '0': 'other_workout', '2': 'badminton', '4': 'baseball', '5': 'basketball',
  '8': 'biking', '9': 'biking_stationary', '10': 'boot_camp', '11': 'boxing',
  '13': 'calisthenics', '14': 'cricket', '16': 'dancing', '25': 'elliptical',
  '26': 'exercise_class', '27': 'fencing', '28': 'football_american',
  '29': 'football_australian', '31': 'frisbee_disc', '32': 'golf',
  '33': 'guided_breathing', '34': 'gymnastics', '35': 'handball', '36': 'hiit',
  '37': 'hiking', '38': 'ice_hockey', '39': 'ice_skating', '44': 'martial_arts',
  '46': 'paddling', '47': 'paragliding', '48': 'pilates', '50': 'racquetball',
  '51': 'rock_climbing', '52': 'roller_hockey', '53': 'rowing', '54': 'rowing_machine',
  '55': 'rugby', '56': 'running', '57': 'running_treadmill', '58': 'sailing',
  '59': 'scuba_diving', '60': 'skating', '61': 'skiing', '62': 'snowboarding',
  '63': 'snowshoeing', '64': 'soccer', '65': 'softball', '66': 'squash',
  '68': 'stair_climbing', '69': 'stair_climbing_machine', '70': 'strength_training',
  '71': 'stretching', '72': 'surfing', '73': 'swimming_open_water',
  '74': 'swimming_pool', '75': 'table_tennis', '76': 'tennis', '78': 'volleyball',
  '79': 'walking', '80': 'water_polo', '81': 'weightlifting', '82': 'wheelchair',
  '83': 'yoga',
}

// Resolve a workout type field into a readable name plus the preserved raw code.
// - numeric HC code -> mapped name (+ typeCode = raw); unmapped code -> 'unknown' (+ typeCode = raw, no data loss)
// - already-descriptive string (non-numeric) -> passed through unchanged, no typeCode
function resolveWorkoutType(raw: string | undefined): { type: string; typeCode?: string } {
  if (raw === undefined) return { type: 'unknown' }
  if (/^\d+$/.test(raw)) {
    return { type: EXERCISE_TYPE_NAMES[raw] ?? 'unknown', typeCode: raw }
  }
  return { type: raw }
}

// Europe/Budapest local calendar date of a UTC ISO timestamp (CEST +2 Mar-Oct,
// CET +1 otherwise -- DST approximation matching the n8n transform's date logic).
function localDateBudapest(isoUtc: string): string | undefined {
  if (!isoUtc) return undefined
  const d = new Date(isoUtc)
  if (Number.isNaN(d.getTime())) return undefined
  const mo = d.getUTCMonth() + 1
  const offH = (mo >= 3 && mo <= 10) ? 2 : 1
  return new Date(d.getTime() + offH * 3600_000).toISOString().slice(0, 10)
}

function mapWorkouts(list: unknown[], snapshotDate: string): ZeppWorkout[] {
  return list
    .map((w: any) => {
      const resolved = resolveWorkoutType(str(w['type']))
      return {
        type: resolved.type,
        ...(resolved.typeCode !== undefined && { typeCode: resolved.typeCode }),
        startAt: str(w['start']) ?? '',
        durationSec: (num(w['duration_min']) ?? 0) * 60,
        avgHr: num(w['avg_hr_bpm']),
        calories: num(w['kcal']),
        distanceM: num(w['distance_m']),
      }
    })
    // Each push carries a 48h rolling window, so one workout recurs across consecutive
    // pushes/dates. File a workout only on its own local day; otherwise the same session
    // lands in two daily files and downstream TRIMP double-counts it. Undatable workouts
    // (missing/invalid start) are kept on the current snapshot to avoid silent loss.
    .filter((w) => {
      const wd = localDateBudapest(w.startAt)
      return wd === undefined || wd === snapshotDate
    })
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function isNonEmpty(obj: Record<string, unknown>): boolean {
  return Object.values(obj).some(v => v !== undefined && v !== null)
}

export function makeHealthIngestHandler(deps: HealthIngestDeps) {
  return async function handleHealthIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return

    const token = (req.headers as Record<string, string | undefined>)['x-ingest-token']
    if (!token || !tokenMatches(token, deps.readIngestToken())) {
      json(res, { error: 'Unauthorized' }, 401)
      return
    }

    let body: Record<string, unknown>
    try {
      const raw = await readBody(req, { maxBytes: MAX_INGEST_BYTES })
      body = JSON.parse(raw.toString()) as Record<string, unknown>
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: 'Payload too large' }, 413)
        return
      }
      json(res, { error: 'Invalid JSON' }, 400)
      return
    }

    const date = str(body['date'])
    if (!date || !DATE_RE.test(date)) {
      json(res, { error: 'Missing or malformed date (YYYY-MM-DD required)' }, 400)
      return
    }

    const pulledAt = deps.nowIso()

    let vitals: ZeppVitals | undefined
    let sleep: ZeppSleep | undefined
    let workouts: ZeppWorkout[] | undefined
    let activity: ZeppActivity | undefined
    let steps: number | undefined
    let caloriesTotal: number | undefined
    let sourceSyncedAt: string | undefined

    if (body['vitals'] && typeof body['vitals'] === 'object') {
      const v = mapVitals(body['vitals'] as Record<string, unknown>)
      if (isNonEmpty(v as Record<string, unknown>)) vitals = v
    }
    if (Array.isArray(body['sleep'])) {
      // Multi-session shape (main night + naps). Empty array -> no sleep block.
      sleep = mapSleepList(body['sleep'])
    } else if (body['sleep'] && typeof body['sleep'] === 'object') {
      // Legacy single-object shape (kept for backward-compat so the ingest can deploy
      // before the transform switches to forwarding the session array).
      sleep = mapSleepSession(body['sleep'] as Record<string, unknown>)
    }
    if (Array.isArray(body['workouts']) && body['workouts'].length > 0) {
      const mapped = mapWorkouts(body['workouts'], date)
      if (mapped.length > 0) workouts = mapped
    }
    if (body['activity'] && typeof body['activity'] === 'object') {
      const a = body['activity'] as Record<string, unknown>
      steps = num(a['steps'])
      caloriesTotal = num(a['total_kcal'])
      const mapped = mapActivity(a)
      if (isNonEmpty(mapped as Record<string, unknown>)) activity = mapped
    }
    if (str(body['synced_at'])) sourceSyncedAt = str(body['synced_at'])

    const hasData = !!(vitals || sleep || workouts || activity || steps !== undefined || caloriesTotal !== undefined)
    const status: ZeppPullStatus = hasData ? 'ok' : 'no_new_data'

    const snapshot: ZeppDailySnapshot = {
      date,
      pulledAt,
      status,
      ...(vitals && { vitals }),
      ...(sleep && { sleep }),
      ...(workouts && { workouts }),
      ...(activity && { activity }),
      ...(steps !== undefined && { steps }),
      ...(caloriesTotal !== undefined && { caloriesTotal }),
      ...(sourceSyncedAt && { sourceSyncedAt }),
    }

    deps.writeSnapshot(snapshot)

    json(res, { status, date, pulledAt })
  }
}

// Production deps
export function makeDefaultHealthIngestDeps(): HealthIngestDeps {
  return {
    readIngestToken,
    writeSnapshot: (snap) => defaultZeppStore.write(snap),
    nowIso: () => new Date().toISOString(),
  }
}

// tryHandle adapter for the web.ts dispatcher
let _handler: ReturnType<typeof makeHealthIngestHandler> | null = null

export async function tryHandleHealthIngest(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/api/health/ingest') return false
  if (!_handler) _handler = makeHealthIngestHandler(makeDefaultHealthIngestDeps())
  await _handler(ctx.req, ctx.res)
  return true
}
