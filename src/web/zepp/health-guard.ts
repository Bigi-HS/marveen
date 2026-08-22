// Zepp pull health guard (WELL-018, silent-guard discipline).
// A broken pull must never read as healthy: this module checks a snapshot and
// returns typed alerts for auth_fail, endpoint_error, partial, and stale.
// Callers (the scheduler / noa-scheduler tick) decide how to surface each alert
// (Telegram, kanban card, log-only). No side effects in this module.

import type { ZeppDailySnapshot, ZeppPullStatus } from './contract.js'

export type AlertType = 'auth_fail' | 'endpoint_error' | 'partial' | 'stale'

export interface HealthGuardAlert {
  type: AlertType
  date: string
  message: string
}

// A pull is stale when no successful (or partial) data arrived for this long.
const STALE_THRESHOLD_MS = 26 * 60 * 60 * 1000

const STATUS_ALERT: Record<Exclude<ZeppPullStatus, 'ok' | 'stale'>, AlertType> = {
  auth_fail: 'auth_fail',
  endpoint_error: 'endpoint_error',
  partial: 'partial',
}

export function checkSnapshot(
  snapshot: ZeppDailySnapshot,
  nowMs: number = Date.now(),
): HealthGuardAlert[] {
  const alerts: HealthGuardAlert[] = []

  // Status-based alerts (auth_fail / endpoint_error / partial)
  if (snapshot.status !== 'ok' && snapshot.status !== 'stale') {
    const type = STATUS_ALERT[snapshot.status as keyof typeof STATUS_ALERT]
    if (type) {
      alerts.push({
        type,
        date: snapshot.date,
        message: `Zepp pull ${snapshot.status} on ${snapshot.date}${snapshot.error ? ': ' + snapshot.error : ''}`,
      })
    }
  }

  // API-reported stale: the pull layer flagged data as stale regardless of pulledAt age.
  // Must alert even when pulledAt is fresh -- failing to do so is itself a silent-guard failure.
  if (snapshot.status === 'stale') {
    alerts.push({
      type: 'stale',
      date: snapshot.date,
      message: `Zepp API reported stale data for ${snapshot.date}`,
    })
  }

  // Staleness: pulledAt is too old regardless of status
  const pulledAtMs = new Date(snapshot.pulledAt).getTime()
  if (nowMs - pulledAtMs > STALE_THRESHOLD_MS) {
    alerts.push({
      type: 'stale',
      date: snapshot.date,
      message: `Zepp data stale: last pull was ${snapshot.pulledAt} (>${Math.round(STALE_THRESHOLD_MS / 3_600_000)}h ago)`,
    })
  }

  return alerts
}
