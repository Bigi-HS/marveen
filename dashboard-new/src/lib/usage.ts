// Claude usage panel (card 7fe5662f) -- pure helpers behind the usage page.
//
// The backend GET /api/usage/current returns ONLY the derived, credential-free
// shape (fiveHour/weekly % + reset ISO timestamps + stale flag), or a 503 with a
// { reason } when the feature is absent / the session is auth-expired. This lib
// types that response and formats the reset countdown -- no DOM, no React, so it
// is unit-tested directly.

export interface UsageWindow {
  pct: number
  resetAt: string // ISO timestamp
}

/** GET /api/usage/current (200). Mirrors the backend UsageState exactly. */
export interface UsageState {
  fiveHour: UsageWindow
  weekly: UsageWindow
  stale: boolean
}

/** GET /api/usage/current (503) body. */
export interface UsageAbsent {
  reason: 'feature-absent' | 'auth-expired' | 'unavailable'
}

/**
 * Compact countdown to a reset ("in 3h 12m", "in 4d 2h", "in 45m", "now").
 * `resetAt` is an ISO timestamp; `nowMs` is epoch milliseconds. A reset in the
 * past (or an unparseable timestamp) renders "now" rather than a negative value.
 */
export function resetCountdown(resetAt: string, nowMs: number): string {
  const target = Date.parse(resetAt)
  if (Number.isNaN(target)) return 'now'
  const deltaSec = Math.floor((target - nowMs) / 1000)
  if (deltaSec <= 0) return 'now'
  const day = Math.floor(deltaSec / 86400)
  const hr = Math.floor((deltaSec % 86400) / 3600)
  const min = Math.floor((deltaSec % 3600) / 60)
  if (day > 0) return `in ${day}d ${hr}h`
  if (hr > 0) return `in ${hr}h ${min}m`
  if (min > 0) return `in ${min}m`
  return 'in <1m'
}

/** Clamp a percentage into 0..100 for the progress bar width (defensive).
 *  NaN -> 0; +/-Infinity clamp to the 100/0 bounds via Math.min/max. */
export function clampPct(pct: number): number {
  if (Number.isNaN(pct)) return 0
  return Math.min(Math.max(pct, 0), 100)
}

/** Bar tone thresholds: calm under 60, warn 60-84, alert 85+. Palette tokens only. */
export function usageTone(pct: number): 'ok' | 'warn' | 'alert' {
  const p = clampPct(pct)
  if (p >= 85) return 'alert'
  if (p >= 60) return 'warn'
  return 'ok'
}
