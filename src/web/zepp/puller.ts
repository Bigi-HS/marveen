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

export type ZeppAuthStyle = 'bearer' | 'apptoken'

export interface ZeppPullDeps {
  apiBaseUrl: string
  accessToken: string
  fetch: typeof globalThis.fetch
  /** de2/apptoken flow: the numeric account id, sent as a request param. */
  userid?: string
  /** How the token is presented. Default 'bearer' preserves the login flow. */
  authStyle?: ZeppAuthStyle
}

// Default Zepp/Huami cloud API base (Zepp app / login flow, not de2 app-token).
export const DEFAULT_API_BASE_URL = 'https://api-mifit.huami.com'

// region -> app-token cloud host. 'de2' => https://api-mifit-de2.zepp.com
// (MITM-confirmed 09-08, doc zepp-accurate-data-auth-architecture-0908).
export function regionToApiBase(region: string): string {
  return `https://api-mifit-${region}.zepp.com`
}

// Trimmed net sleep (minutes) = asleep stages only (deep+light+rem), excluding
// awake. This is the app-displayed "net" figure; the in-bed span/headline is
// larger and is what Health Connect over-counts. Verified vs the local DB gold
// (09-09 net = 464 min).
export function netSleepMin(stages?: { deep?: number; light?: number; rem?: number; awake?: number }): number | undefined {
  if (!stages) return undefined
  return (stages.deep ?? 0) + (stages.light ?? 0) + (stages.rem ?? 0)
}

function authHeaders(deps: ZeppPullDeps): Record<string, string> {
  const base: Record<string, string> = { 'Content-Type': 'application/json' }
  if (deps.authStyle === 'apptoken') return { ...base, apptoken: deps.accessToken }
  return { ...base, Authorization: `Bearer ${deps.accessToken}` }
}

// Append userid as a query param when present (de2 flow). Query-param placement
// is the best-known default; the path form (/users/<userid>/...) is the
// alternative to confirm at verify (card 8001dd41).
function withUserid(url: string, deps: ZeppPullDeps): string {
  if (!deps.userid) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}userid=${encodeURIComponent(deps.userid)}`
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
  const url = withUserid(`${deps.apiBaseUrl}/v1/sport/sleep/detail?date=${date}`, deps)
  const { ok, body } = await safeFetch(url, { headers: authHeaders(deps) }, deps)
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
  const url = withUserid(`${deps.apiBaseUrl}/v1/health/vitals?date=${date}`, deps)
  const { ok, body } = await safeFetch(url, { headers: authHeaders(deps) }, deps)
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
  const url = withUserid(`${deps.apiBaseUrl}/v1/sport/history?date=${date}`, deps)
  const { ok, body } = await safeFetch(url, { headers: authHeaders(deps) }, deps)
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
