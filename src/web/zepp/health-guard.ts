// Zepp pull health guard (WELL-018, silent-guard discipline).
// A broken pull must never read as healthy: this module checks a snapshot and
// returns typed alerts for auth_fail, endpoint_error, partial, and stale.
// Callers (the scheduler / noa-scheduler tick) decide how to surface each alert
// (Telegram, kanban card, log-only). No side effects in this module.

import type { ZeppDailySnapshot, ZeppPullStatus } from './contract.js'
import { validateHealthPlausibility, hasSuspectViolation } from './health-plausibility.js'

// 'suspect' is a numeric-plausibility alert (the pull SUCCEEDED but the numbers are
// physically implausible -- see health-plausibility.ts). It is NOT a ZeppPullStatus:
// the stored snapshot is left untouched (log-only rollout, card 75337cdc). Escalation
// to a status downgrade is a later step once the false-positive rate is known.
export type AlertType = 'auth_fail' | 'endpoint_error' | 'partial' | 'stale' | 'suspect'

export interface HealthGuardAlert {
  type: AlertType
  date: string
  message: string
}

// A pull is stale when no successful (or partial) data arrived for this long.
const STALE_THRESHOLD_MS = 26 * 60 * 60 * 1000

const STATUS_ALERT: Record<Exclude<ZeppPullStatus, 'ok' | 'stale' | 'no_new_data'>, AlertType> = {
  auth_fail: 'auth_fail',
  endpoint_error: 'endpoint_error',
  partial: 'partial',
}

// #6 (card e3197a20): snapshot.error originates in the pull layer (the Zepp API response).
// Before it rides into an alert message (Telegram / kanban / log) collapse it to a single
// bounded, printable line: replace control chars so a newline cannot inject a fake line, and
// cap the length so a leaked blob cannot dump into the surface. Empty-after-sanitize ->
// undefined (no ": " suffix appended).
const MAX_ERROR_LEN = 200

function sanitizeErrorForAlert(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // Replace ASCII control chars (code < 0x20, incl. newlines/tabs, and DEL 0x7f) with a
  // space via charCode inspection -- deliberately NOT a control-char regex literal, which
  // would embed a NUL byte in this source file (no-nul-in-tracked-sources guard). Then
  // collapse whitespace and cap the length.
  let out = ''
  for (const ch of raw) {
    const code = ch.charCodeAt(0)
    out += code < 0x20 || code === 0x7f ? ' ' : ch
  }
  const oneLine = out.replace(/\s+/g, ' ').trim()
  if (oneLine.length === 0) return undefined
  return oneLine.length > MAX_ERROR_LEN ? oneLine.slice(0, MAX_ERROR_LEN) + '...' : oneLine
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
      const err = sanitizeErrorForAlert(snapshot.error)
      alerts.push({
        type,
        date: snapshot.date,
        message: `Zepp pull ${snapshot.status} on ${snapshot.date}${err ? ': ' + err : ''}`,
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

  // Numeric plausibility: a status-ok snapshot can still carry physically impossible
  // numbers (e.g. activeKcal=5 at 15,790 steps). Surface those as a 'suspect' alert so a
  // broken aggregate does not silently feed goal-calc. Detection only -- the snapshot is
  // not mutated.
  const plausibility = validateHealthPlausibility(snapshot)
  if (hasSuspectViolation(plausibility)) {
    alerts.push({
      type: 'suspect',
      date: snapshot.date,
      message: `Zepp data implausible for ${snapshot.date}: ${plausibility
        .filter((v) => v.severity === 'suspect')
        .map((v) => v.message)
        .join('; ')}`,
    })
  }

  return alerts
}
