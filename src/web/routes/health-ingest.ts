// POST /api/health/ingest -- Health Connect push ingress (WELL-018 Path A).
// Phone automation (Automate / HTTP Shortcuts) POSTs HC data once per schedule.
// Auth: X-Ingest-Token header (dedicated secret, distinct from dashboard bearer).
// The endpoint is public via Cloudflare tunnel -> the token gate is load-bearing.
//
// Idempotency: same-date pushes accumulate via a field-level no-clobber merge (AC-A8).
// The phone may push several times per day (sleep in the morning, a workout in the
// evening) as separate deltas; a full-file overwrite would silently wipe whatever an
// earlier push wrote. The handler reads the existing snapshot and merges the incoming
// push field-by-field (present -> replace, absent/null -> keep), recomputing status so a
// bare no_new_data push never downgrades an ok day. See snapshot-merge.ts.
// Silent-guard: always writes a snapshot -- an empty or failed push is still visible.

import { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { readBody, RequestBodyTooLargeError, json } from '../http-helpers.js'
import { defaultZeppStore } from '../zepp/ingest-store.js'
import { mergeDailySnapshot } from '../zepp/snapshot-merge.js'
import { applyDistanceEstimate } from '../zepp/distance-estimate.js'
import { applyKcalSuspectLabel } from '../zepp/kcal-suspect.js'
import { defaultZeppAnomalyStore } from '../zepp/anomaly-store.js'
import { readIngestToken } from '../zepp/ingest-secret.js'
import { writeValidatedSnapshot } from '../zepp/validated-ingest.js'
import {
  hasSuspectViolation, type PlausibilityViolation,
} from '../zepp/health-plausibility.js'
import {
  validateDataDate, hasDataDateViolation, type DataDateViolation,
} from '../zepp/data-date-guard.js'
import { logger } from '../../logger.js'
import type {
  ZeppDailySnapshot, ZeppVitals, ZeppSleep, ZeppWorkout, ZeppActivity, ZeppDistanceSlice, ZeppPullStatus,
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
  // Read the existing daily snapshot for a date (null if none), so a partial push merges
  // onto it instead of overwriting it (AC-A8 no-clobber).
  readSnapshot: (date: string) => ZeppDailySnapshot | null
  writeSnapshot: (snap: ZeppDailySnapshot) => void
  nowIso: () => string
  // Called (log-only for now) when the merged snapshot fails a numeric plausibility check
  // (card 75337cdc). Detection only: the stored snapshot is never mutated. Optional so
  // callers that do not care can omit it.
  onPlausibility?: (snapshot: ZeppDailySnapshot, violations: PlausibilityViolation[]) => void
  // Called (log-only) when a stored snapshot's timestamped fields resolve to a different
  // Budapest day than snapshot.date (card 75337cdc Q2) -- a producer mis-filing signal.
  // Detection only: the stored snapshot is never mutated. Optional.
  onDataDate?: (snapshot: ZeppDailySnapshot, violations: DataDateViolation[]) => void
  // G3 (card 44783957 P0): persist the cross-field anomaly signal as a queryable health flag
  // instead of only logging it. Called on EVERY push with the current suspect violations
  // (possibly empty) so a clean push RESOLVES an open flag -- self-correcting, mirroring the
  // step-estimate remediation. Optional. Never mutates the stored snapshot.
  recordAnomaly?: (date: string, suspect: PlausibilityViolation[]) => void
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

// Map the raw HC distance slices (start/end/meters) into ledger slices. Each slice needs a
// startAt (the ledger dedup key) and a finite, NON-NEGATIVE meters; malformed entries are
// dropped rather than poisoning the day's sum. num() accepts negative finite values, so a
// negative meters slice would drag the ledger sum DOWN -- the exact clobber-down the ledger
// exists to prevent -- hence the explicit meters < 0 drop (chad gate FLAG seat 801).
function mapDistanceSlices(raw: unknown): ZeppDistanceSlice[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const slices: ZeppDistanceSlice[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const rec = r as Record<string, unknown>
    const startAt = str(rec['start']) ?? str(rec['startAt'])
    const meters = num(rec['meters']) ?? num(rec['distance_m'])
    if (startAt === undefined || meters === undefined || meters < 0) continue
    const endAt = str(rec['end']) ?? str(rec['endAt'])
    slices.push({ startAt, ...(endAt !== undefined && { endAt }), meters })
  }
  return slices.length > 0 ? slices : undefined
}

function mapActivity(a: Record<string, unknown>): ZeppActivity {
  const slices = mapDistanceSlices(a['distance_slices'])
  return {
    activeKcal: numCapped(a['active_kcal'], MAX_KCAL_PER_DAY),
    distanceM: numCapped(a['distance_m'], MAX_DISTANCE_M_PER_DAY),
    ...(slices && { distanceSlices: slices }),
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

// Zepp fragments one continuous activity into several short same-type records (measured
// on the real backfill: type-79 walks arrive as ~10-16 min pieces with 2-9 min gaps,
// while genuinely separate sessions sit 20+ min apart). Merge consecutive same-type
// records whose inter-record gap is within this threshold so a downstream load model
// (hibiki TRIMP/CTL/ATL) sees one activity instead of N fragments. 10 min cleanly
// captures the fragment gaps without swallowing distinct sessions.
const WORKOUT_MERGE_GAP_SEC = 10 * 60

// HC heart_rate buckets are ~15 min apart, so a short workout can span zero buckets on a
// strict [start, end] window. Widen by half the bucket spacing on each side so every
// workout captures at least the nearest sample (measured: this lifts real-blob coverage
// from 32/41 to 41/41 sessions). The Zepp exercise record carries no HR of its own, so
// this windowed mean is the per-workout avgHr the load model (Banister TRIMP) needs --
// distinct from the whole-day vitals.hrAvg, which covers the entire day, not the session.
const HR_WINDOW_TOL_SEC = 7.5 * 60

// Mean of the heart_rate bucket avgs whose sample time falls in the workout's window
// (start-tol .. start+durationSec+tol). Returns undefined when no bucket lands in range.
function windowedAvgHr(
  hrBuckets: Array<{ time?: unknown; avg?: unknown }>,
  startAt: string,
  durationSec: number,
): number | undefined {
  const start = new Date(startAt).getTime()
  if (Number.isNaN(start)) return undefined
  const lo = start - HR_WINDOW_TOL_SEC * 1000
  const hi = start + durationSec * 1000 + HR_WINDOW_TOL_SEC * 1000
  let sum = 0
  let n = 0
  for (const b of hrBuckets) {
    const t = new Date(str(b.time) ?? '').getTime()
    const v = num(b.avg)
    if (!Number.isNaN(t) && t >= lo && t <= hi && v !== undefined) { sum += v; n++ }
  }
  return n > 0 ? Math.round(sum / n) : undefined
}

function mergeConsecutiveWorkouts(workouts: ZeppWorkout[]): ZeppWorkout[] {
  if (workouts.length <= 1) return workouts
  // Sort by start so "consecutive" is by clock time, not source order.
  const sorted = [...workouts].sort((a, b) => a.startAt.localeCompare(b.startAt))
  const out: ZeppWorkout[] = []
  let cur: ZeppWorkout | null = null
  let curEndMs = Number.NEGATIVE_INFINITY // true clock end of the running session
  let hrWeighted = 0 // Sum(avgHr * durationSec) over fragments that reported avgHr
  let hrDur = 0 // Sum(durationSec) over fragments that reported avgHr
  const flush = () => {
    if (!cur) return
    // Duration-weighted avgHr across the merged fragments (only those that had one).
    if (hrDur > 0) cur.avgHr = Math.round(hrWeighted / hrDur)
    out.push(cur)
  }
  for (const w of sorted) {
    const startMs = new Date(w.startAt).getTime()
    const endMs = Number.isNaN(startMs) ? Number.NaN : startMs + w.durationSec * 1000
    const contiguous =
      cur !== null &&
      cur.type === w.type &&
      !Number.isNaN(startMs) &&
      (startMs - curEndMs) / 1000 <= WORKOUT_MERGE_GAP_SEC
    if (contiguous) {
      // Extend the running session. Active duration is the SUM of fragment durations
      // (the gap is rest, not active time); distance/calories accumulate.
      cur!.durationSec += w.durationSec
      if (w.distanceM !== undefined) cur!.distanceM = (cur!.distanceM ?? 0) + w.distanceM
      if (w.calories !== undefined) cur!.calories = (cur!.calories ?? 0) + w.calories
      if (w.avgHr !== undefined) { hrWeighted += w.avgHr * w.durationSec; hrDur += w.durationSec }
      curEndMs = Math.max(curEndMs, endMs)
    } else {
      flush()
      cur = { ...w }
      curEndMs = Number.isNaN(endMs) ? Number.NEGATIVE_INFINITY : endMs
      hrWeighted = w.avgHr !== undefined ? w.avgHr * w.durationSec : 0
      hrDur = w.avgHr !== undefined ? w.durationSec : 0
    }
  }
  flush()
  return out
}

function mapWorkouts(
  list: unknown[],
  snapshotDate: string,
  hrBuckets: Array<{ time?: unknown; avg?: unknown }>,
): ZeppWorkout[] {
  const mapped = list
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
  // Fill per-workout avgHr from the HR buckets for fragments the source left without one,
  // BEFORE merging -- so the merge's duration-weighting produces the session avgHr. A
  // source-provided avgHr is left untouched.
  for (const w of mapped) {
    if (w.avgHr === undefined) {
      const hr = windowedAvgHr(hrBuckets, w.startAt, w.durationSec)
      if (hr !== undefined) w.avgHr = hr
    }
  }
  return mergeConsecutiveWorkouts(mapped)
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// AC#1 (card e3197a20): physiological input caps for fields whose upstream source
// can produce phantom values (e.g. steps=999,999 -> 762km step-estimate chain).
// Values outside [0, max] are dropped (undefined) so the anomaly never enters the
// monotone-max lock or the distance-estimate remediation path.
const MAX_STEPS_PER_DAY = 100_000
const MAX_KCAL_PER_DAY = 10_000
const MAX_DISTANCE_M_PER_DAY = 500_000

function numCapped(v: unknown, max: number): number | undefined {
  const n = num(v)
  if (n === undefined) return undefined
  if (n < 0 || n > max) {
    logger.warn({ value: n, max }, 'zepp ingest: input value outside sane range, dropping field')
    return undefined
  }
  return n
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
    // Own-date filter for sleep (2f603c1c): mirror of the workout own-day filter.
    // Use the sleep's wake date (endAt localDateBudapest) as the filing day.
    // Edge: a midnight push (00:20) where body.date = new_day but the payload still
    // carries yesterday's sleep (endAt = yesterday) must NOT mis-file under new_day.
    // Missing/invalid endAt -> keep the sleep on the current snapshot (same as workout).
    if (sleep !== undefined) {
      const sleepEndDate = localDateBudapest(sleep.endAt)
      if (sleepEndDate !== undefined && sleepEndDate !== date) {
        sleep = undefined
      }
    }
    if (Array.isArray(body['workouts']) && body['workouts'].length > 0) {
      const hrBuckets = Array.isArray(body['heart_rate'])
        ? (body['heart_rate'] as Array<{ time?: unknown; avg?: unknown }>)
        : []
      const mapped = mapWorkouts(body['workouts'], date, hrBuckets)
      if (mapped.length > 0) workouts = mapped
    }
    if (body['activity'] && typeof body['activity'] === 'object') {
      const a = body['activity'] as Record<string, unknown>
      steps = numCapped(a['steps'], MAX_STEPS_PER_DAY)
      caloriesTotal = numCapped(a['total_kcal'], MAX_KCAL_PER_DAY)
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

    // Read-modify-write: merge this push onto the existing day so a partial/empty push
    // never clobbers data an earlier push stored (AC-A8). First write of the day (no
    // existing record) passes through unchanged.
    const existing = deps.readSnapshot(date)
    const merged = mergeDailySnapshot(existing, snapshot)
    // Distance-estimate remediation (WELL-028): when the merged day's measured distance is
    // implausibly short for its steps (BUG-2 upstream loss), label distanceSource and add a
    // step-derived estimate. Runs on the MERGED day so it sees the accumulated steps/distance,
    // and re-runs each push so a later real distance drops a stale estimate. Never overwrites
    // the measured distanceM.
    // Then label activeKcal suspect when it is implausibly low for the merged day's steps
    // (card 75337cdc, the raw upstream loss). A LABEL only -- activeKcal is never overwritten;
    // Hibiki's dynamic calorie goal reads activeKcalSuspect and falls back to its floor. Runs
    // on the finalized day and re-evaluates each push so a later plausible value clears it.
    const finalized = applyKcalSuspectLabel(applyDistanceEstimate(merged))

    // Numeric plausibility guard (log-only rollout, card 75337cdc). Run on the finalized day
    // so activity+steps are judged together. Detection only -- status is not downgraded.
    // Write + validate + persist the anomaly flag go through the shared validated funnel
    // (WELL-027 WS1) so the push and pull paths cannot drift on which writes get flagged.
    // G3 (card 44783957 P0): the anomaly flag is persisted/resolved on EVERY push so the
    // suspect signal reaches a monitor (not a silent log line), and a later clean push clears
    // an open flag.
    const violations = writeValidatedSnapshot(finalized, {
      writeSnapshot: deps.writeSnapshot,
      recordAnomaly: (date, suspect) => deps.recordAnomaly?.(date, suspect),
    })
    if (hasSuspectViolation(violations)) {
      deps.onPlausibility?.(finalized, violations)
    }

    // Data-date guard (log-only, card 75337cdc Q2). Catches a producer that filed a record
    // under the wrong day (the F1 mis-filing class). Detection only -- no status change.
    const dateViolations = validateDataDate(finalized)
    if (hasDataDateViolation(dateViolations)) {
      deps.onDataDate?.(finalized, dateViolations)
    }

    json(res, { status: merged.status, date, pulledAt: merged.pulledAt })
  }
}

// Production deps
export function makeDefaultHealthIngestDeps(): HealthIngestDeps {
  return {
    readIngestToken,
    readSnapshot: (date) => defaultZeppStore.read(date),
    writeSnapshot: (snap) => defaultZeppStore.write(snap),
    nowIso: () => new Date().toISOString(),
    onPlausibility: (snap, violations) => {
      logger.warn(
        { date: snap.date, violations },
        `zepp plausibility: ${violations.filter((v) => v.severity === 'suspect').length} suspect on ${snap.date} -- ${violations.map((v) => v.message).join('; ')}`,
      )
    },
    recordAnomaly: (date, suspect) => {
      // Upsert-or-resolve the persistent cross-field anomaly flag (G3). The store keeps the
      // detection episode's detectedAt and resolves an open flag when suspect is empty.
      defaultZeppAnomalyStore.record(date, suspect, new Date().toISOString())
    },
    onDataDate: (snap, violations) => {
      logger.warn(
        { date: snap.date, violations },
        `zepp data-date: ${violations.length} field(s) mis-filed on ${snap.date} -- ${violations.map((v) => `${v.field} belongs to ${v.actual}`).join('; ')}`,
      )
    },
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
