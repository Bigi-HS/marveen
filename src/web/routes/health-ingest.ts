// POST /api/health/ingest -- Health Connect push ingress (WELL-018 Path A).
// Phone automation (Automate / HTTP Shortcuts) POSTs HC data once per schedule.
// Auth: X-Ingest-Token header (dedicated secret, distinct from dashboard bearer).
// The endpoint is public via Cloudflare tunnel -> the token gate is load-bearing.
//
// Idempotency: same-date overwrites (last-write-wins). The phone may push several
// times per day (sleep in morning, activity in evening); each overwrites the file.
// Silent-guard: always writes a snapshot -- an empty or failed push is visible.

import { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, json } from '../http-helpers.js'
import { defaultZeppStore } from '../zepp/ingest-store.js'
import { readIngestToken } from '../zepp/ingest-secret.js'
import type {
  ZeppDailySnapshot, ZeppVitals, ZeppSleep, ZeppWorkout, ZeppActivity, ZeppPullStatus,
} from '../zepp/contract.js'
import type { RouteContext } from './types.js'

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

function mapSleep(s: Record<string, unknown>): ZeppSleep {
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

function mapActivity(a: Record<string, unknown>): ZeppActivity {
  return {
    activeKcal: num(a['active_kcal']),
    distanceM: num(a['distance_m']),
    floors: num(a['floors']),
    vo2max: num(a['vo2max']),
  }
}

function mapWorkouts(list: unknown[]): ZeppWorkout[] {
  return list.map((w: any) => ({
    type: str(w['type']) ?? 'unknown',
    startAt: str(w['start']) ?? '',
    durationSec: (num(w['duration_min']) ?? 0) * 60,
    avgHr: num(w['avg_hr_bpm']),
    calories: num(w['kcal']),
    distanceM: num(w['distance_m']),
  }))
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
    if (!token || token !== deps.readIngestToken()) {
      json(res, { error: 'Unauthorized' }, 401)
      return
    }

    let body: Record<string, unknown>
    try {
      const raw = await readBody(req)
      body = JSON.parse(raw.toString()) as Record<string, unknown>
    } catch {
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
    if (body['sleep'] && typeof body['sleep'] === 'object') {
      sleep = mapSleep(body['sleep'] as Record<string, unknown>)
    }
    if (Array.isArray(body['workouts']) && body['workouts'].length > 0) {
      workouts = mapWorkouts(body['workouts'])
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
