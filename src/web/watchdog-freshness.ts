// Freshness / staleness assessment for the pipe watchdogs.
//
// Root cause this closes (card 35dc7d87, hibiki 2026-06-22): a persisted
// watchdog state with `consecutiveDead === 0` was read as "healthy" even though
// no real check had refreshed it for ~18h. A cached counter only means what it
// says if it was WRITTEN BY A RECENT CHECK; a stale or never-written state must
// never masquerade as green. These pure functions encode that rule so every
// consumer (status reports, the stale-health backstop sweep) treats an
// un-refreshed state as actionable, not healthy.

// A per-agent watchdog cycle runs on a ~5-min cadence. Treat a state whose last
// real check is older than three missed cadences (15 min) as stale: long enough
// that a single skipped tick or clock jitter cannot false-trip it, far short of
// the 18h blind window that hid the dead pipe.
export const DEFAULT_STALE_AFTER_MS = 15 * 60 * 1000

export type Freshness = 'fresh' | 'stale' | 'never-checked'

// How recently was this state actually verified by a probe? A future timestamp
// (clock skew) is treated as fresh -- it is never evidence of staleness.
export function classifyFreshness(
  lastCheckedTs: number | null | undefined,
  now: number,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): Freshness {
  if (lastCheckedTs == null) return 'never-checked'
  if (now - lastCheckedTs > staleAfterMs) return 'stale'
  return 'fresh'
}

export type ReportedHealth = 'healthy' | 'dead' | 'stale' | 'unknown'

export interface HealthInput {
  consecutiveDead: number
  lastCheckedTs: number | null | undefined
  now: number
  staleAfterMs?: number
}

// The fix for the dead-pipe-but-stale-state-healthy false negative: a cached
// `consecutiveDead === 0` only counts as healthy when a RECENT check wrote it.
// A stale state reports 'stale' and a never-written one 'unknown' -- both
// actionable -- so a watchdog that silently stopped checking can no longer read
// as green.
export function assessReportedHealth({
  consecutiveDead,
  lastCheckedTs,
  now,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
}: HealthInput): ReportedHealth {
  const freshness = classifyFreshness(lastCheckedTs, now, staleAfterMs)
  if (freshness === 'never-checked') return 'unknown'
  if (freshness === 'stale') return 'stale'
  return consecutiveDead > 0 ? 'dead' : 'healthy'
}

// Everything except a fresh, zero-dead 'healthy' warrants a real probe / alert.
export function isActionable(health: ReportedHealth): boolean {
  return health !== 'healthy'
}
