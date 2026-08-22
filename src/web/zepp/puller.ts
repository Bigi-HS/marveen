// Zepp cloud data pull -- sleep, vitals, workouts (WELL-018).
// Hits the unofficial Zepp/Huami cloud endpoints (rolandsz exporter pattern).
// All HTTP is injected so tests run without network or credentials.
//
// Endpoint drift risk: unofficial APIs can break on Zepp infra changes.
// auth_fail (401) and endpoint_error (5xx) are surfaced as typed errors so
// pull-runner can write a failed snapshot and the health-guard alerts.

import type { ZeppSleep, ZeppVitals, ZeppWorkout } from './contract.js'

export class ZeppEndpointError extends Error {
  readonly type = 'endpoint_error' as const
  constructor(message: string) {
    super(message)
    this.name = 'ZeppEndpointError'
  }
}

export class ZeppAuthError extends Error {
  readonly type = 'auth_fail' as const
  constructor(message: string) {
    super(message)
    this.name = 'ZeppAuthError'
  }
}

export interface ZeppPullDeps {
  apiBaseUrl: string
  accessToken: string
  fetch: typeof globalThis.fetch
}

// Default Zepp/Huami cloud API base (Zepp app flow, not Zepp Life).
export const DEFAULT_API_BASE_URL = 'https://api-mifit.huami.com'

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function safeFetch(
  url: string,
  opts: RequestInit,
  deps: ZeppPullDeps,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await deps.fetch(url, opts)
  if (res.status === 401) throw new ZeppAuthError(`Zepp API 401 at ${url}`)
  if (!res.ok && res.status !== 404) throw new ZeppEndpointError(`Zepp API ${res.status} at ${url}`)
  const body = res.ok ? await res.json().catch(() => null) : null
  return { ok: res.ok, status: res.status, body }
}

export async function pullSleep(date: string, deps: ZeppPullDeps): Promise<ZeppSleep | null> {
  const url = `${deps.apiBaseUrl}/v1/sport/sleep/detail?date=${date}`
  const { ok, body } = await safeFetch(url, { headers: authHeaders(deps.accessToken) }, deps)
  if (!ok || !body) return null
  const d = (body as any).data
  if (!d) return null
  const durationSec: number = d.sleep_duration ?? 0
  const stages = Array.isArray(d.sleep_stages)
    ? d.sleep_stages.reduce((acc: Record<string, number>, s: any) => {
        const key = (s.stage as string).toLowerCase() as 'deep' | 'rem' | 'light' | 'awake'
        acc[key] = Math.round((s.seconds ?? 0) / 60)
        return acc
      }, {})
    : undefined
  return {
    durationMin: Math.round(durationSec / 60),
    startAt: d.start_time ? new Date(d.start_time * 1000).toISOString() : date + 'T00:00:00Z',
    endAt: d.stop_time ? new Date(d.stop_time * 1000).toISOString() : date + 'T08:00:00Z',
    score: d.score,
    stages,
  }
}

export async function pullVitals(date: string, deps: ZeppPullDeps): Promise<ZeppVitals | null> {
  const url = `${deps.apiBaseUrl}/v1/health/vitals?date=${date}`
  const { ok, body } = await safeFetch(url, { headers: authHeaders(deps.accessToken) }, deps)
  if (!ok || !body) return null
  const d = (body as any).data
  if (!d) return null
  return {
    restingHr: d.heart_rate_resting,
    spo2: d.spo2,
    hrv: d.hrv,
    stress: d.stress,
    skinTemp: d.skin_temperature,
    breathingRate: d.breathing_rate,
  }
}

export async function pullWorkouts(date: string, deps: ZeppPullDeps): Promise<ZeppWorkout[]> {
  const url = `${deps.apiBaseUrl}/v1/sport/history?date=${date}`
  const { ok, body } = await safeFetch(url, { headers: authHeaders(deps.accessToken) }, deps)
  if (!ok || !body) return []
  const items: any[] = (body as any).data ?? []
  return items.map((w: any) => ({
    type: w.type ?? 'unknown',
    startAt: w.start_time ? new Date(w.start_time * 1000).toISOString() : date + 'T00:00:00Z',
    durationSec: w.end_time && w.start_time ? w.end_time - w.start_time : (w.duration_seconds ?? 0),
    distanceM: w.distance,
    avgHr: w.avg_heart_rate,
    calories: w.calories,
    vo2max: w.vo2max,
  }))
}
