// Zepp accurate-sleep from the Huami/Zepp CLOUD band_data endpoint (token-mode, de2 region).
//
// Why this exists alongside puller.ts:
//   The legacy pullSleep() hits `/v1/sport/sleep/detail` with a Bearer token -- that shape
//   returns 200 on the de2 host but carries no day array, so parsing yields nothing
//   (the "200 but days_parsed={}" symptom). The real Zepp app reads sleep from
//   `/v1/data/band_data.json` with an `apptoken` HEADER (not Bearer) and a from/to date
//   window. Each returned day carries a `summary` string whose `slp` object is byte-for-byte
//   the same structure the local-DB path already parses -- so we reuse parseSummarySleep()
//   and net = deep+light+rem (the app-displayed figure; awake excluded).
//
// Verified 2026-09-09: dp142 + lt322 + rem0 = 464 min = 7h44m, matching Boss's phone.
//
// Endpoint-drift discipline: 401 -> ZeppAuthError (apptoken expired ~monthly, needs re-capture);
// 5xx -> ZeppEndpointError. Both surface up so the health-guard alerts instead of silently
// re-introducing the missing-data defect.

import type { ZeppSleep } from './contract.js'
import { parseSummarySleep } from './local-db-source.js'
import { ZeppAuthError, ZeppEndpointError } from './puller.js'

export interface CloudPullDeps {
  /** de2 host, e.g. api-mifit-de2.zepp.com (from the creds file). */
  host: string
  /** The captured Zepp app session token, sent as the `apptoken` header. */
  appToken: string
  /** Zepp numeric user id (path/param on the band_data call). */
  userId: string
  fetch: typeof globalThis.fetch
}

/** One element of the band_data.json `data` array (only the fields we read). */
interface BandDataDay {
  date_time?: string
  date?: string
  summary?: string
}

/**
 * Build the band_data.json summary URL for a [from,to] date window. `query_type=summary`
 * returns one row per day with the day's `slp`/`stp` summary; `device_type=android_phone`
 * matches the app's own request so the server returns the phone-computed (trimmed) sleep.
 */
export function buildBandDataUrl(host: string, userId: string, fromDate: string, toDate: string): string {
  const params = new URLSearchParams({
    query_type: 'summary',
    device_type: 'android_phone',
    userid: userId,
    from_date: fromDate,
    to_date: toDate,
  })
  return `https://${host}/v1/data/band_data.json?${params.toString()}`
}

/**
 * The band_data `summary` is usually a JSON string but older firmware base64-encodes it.
 * Try raw JSON first (parseSummarySleep validates it); on failure, base64-decode and retry.
 */
export function parseBandDataDay(day: BandDataDay, date: string): ZeppSleep | null {
  const raw = day.summary
  if (!raw || typeof raw !== 'string') return null
  const direct = parseSummarySleep(raw, date)
  if (direct) return direct
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8')
    return parseSummarySleep(decoded, date)
  } catch {
    return null
  }
}

/**
 * Pull the accurate net sleep for a single local date from the de2 cloud. Queries a
 * one-day window and returns the matching day's sleep, or null when the day is absent
 * or carries no usable sleep. The apptoken travels only in the request header and is
 * never returned or logged.
 */
export async function pullCloudSleep(date: string, deps: CloudPullDeps): Promise<ZeppSleep | null> {
  const url = buildBandDataUrl(deps.host, deps.userId, date, date)
  const res = await deps.fetch(url, {
    headers: { apptoken: deps.appToken, 'Content-Type': 'application/json' },
  })
  if (res.status === 401) throw new ZeppAuthError(`Zepp band_data 401 (apptoken expired?) at ${deps.host}`)
  if (!res.ok && res.status !== 404) throw new ZeppEndpointError(`Zepp band_data ${res.status} at ${deps.host}`)
  if (!res.ok) return null

  const body = (await res.json().catch(() => null)) as { data?: BandDataDay[] } | null
  const days = body?.data
  if (!Array.isArray(days)) return null

  // The window is one day, but tolerate multi-day responses: pick the exact date match,
  // falling back to the sole element when the server omits/renames the date field.
  const match =
    days.find((d) => d.date_time === date || d.date === date) ?? (days.length === 1 ? days[0] : undefined)
  if (!match) return null
  return parseBandDataDay(match, date)
}
