// To-Do widget freshness check -- server-side, in-process (card 9ad7334e).
//
// This is the TS-native port of scripts/todo-freshness-check.py, moved off the
// agent-injected scheduled task so it never depends on a busy agent session. A
// deterministic periodic check belongs behind a server endpoint the scheduler
// (n8n schedule-trigger / native cron) hits directly -- the shared "non-session
// periodic task" pattern (with token-usage-collect, whose n8n workflow already
// POSTs /api/token-usage/collect).
//
// Behaviour (FS-AC4), identical to the python detector it replaces:
//   * no rows for an owner        -> skip (not a failure).
//   * last write <= threshold     -> ok, clears any prior alert marker.
//   * last write >  threshold     -> alert marveen, unless suppressed this cycle.
// A per-owner last-alert epoch (suppression state) prevents re-alerting every run
// for the same ongoing outage; a fresh write clears it on the next run.

export const FRESHNESS_THRESHOLD_SECONDS = 93600 // 26h (FS-AC4)
export const FRESHNESS_REALERT_SUPPRESS_SECONDS = 23 * 3600
// Owners watched by the detector -- matches the python OWNERS exactly (bond is a
// newer to-do owner the freshness heartbeat did not cover; kept out to preserve
// behaviour, add here if it should be watched).
export const FRESHNESS_OWNERS: readonly string[] = ['claudia', 'hibiki']

export type FreshnessState = 'no-rows' | 'stale' | 'ok'
export interface FreshnessVerdict {
  owner: string
  state: FreshnessState
  ago: number | null
}

// Per-owner last-alert epoch seconds. Absent owner = never alerted.
export type FreshnessAlertState = Record<string, number>

export interface FreshnessAlert {
  owner: string
  ago: number
  content: string
}

// Pure evaluation: one verdict per owner (no IO). `agoFn` returns the seconds
// since the owner's most recent todo_items write, or null when the owner has no
// rows.
export function evaluateFreshness(
  owners: readonly string[],
  agoFn: (owner: string) => number | null,
  threshold: number = FRESHNESS_THRESHOLD_SECONDS,
): FreshnessVerdict[] {
  return owners.map((owner) => {
    const ago = agoFn(owner)
    if (ago === null) return { owner, state: 'no-rows', ago: null }
    if (ago > threshold) return { owner, state: 'stale', ago }
    return { owner, state: 'ok', ago }
  })
}

export function freshnessAlertContent(owner: string, ago: number): string {
  const hours = Math.floor(ago / 3600)
  return `FRESHNESS ALERT: ${owner} has not written to todo_items in ${hours}h. Check agent health.`
}

export interface FreshnessDecision {
  alerts: FreshnessAlert[]
  nextState: FreshnessAlertState
}

// Pure: decide which stale owners to alert now, honouring the re-alert suppression
// window, and clearing markers for healthy/empty owners. Returns the alerts to
// send and the next suppression state (does not mutate the input).
export function decideFreshnessAlerts(
  verdicts: FreshnessVerdict[],
  state: FreshnessAlertState,
  now: number,
  suppressSeconds: number = FRESHNESS_REALERT_SUPPRESS_SECONDS,
): FreshnessDecision {
  const nextState: FreshnessAlertState = { ...state }
  const alerts: FreshnessAlert[] = []
  for (const v of verdicts) {
    if (v.state !== 'stale') {
      // A healthy/empty owner clears any prior alert marker.
      delete nextState[v.owner]
      continue
    }
    const ago = v.ago as number
    const lastAlert = nextState[v.owner] ?? 0
    if (now - lastAlert < suppressSeconds) continue // suppressed this cycle
    nextState[v.owner] = now
    alerts.push({ owner: v.owner, ago, content: freshnessAlertContent(v.owner, ago) })
  }
  return { alerts, nextState }
}

export interface FreshnessCheckDeps {
  now: number
  agoFn: (owner: string) => number | null
  loadState: () => FreshnessAlertState
  saveState: (state: FreshnessAlertState) => void
  send: (alert: FreshnessAlert) => void
  owners?: readonly string[]
  threshold?: number
  suppressSeconds?: number
  // Report what WOULD alert without sending or persisting; ignores suppression
  // (fresh state), mirroring the python --dry-run.
  dryRun?: boolean
}

export interface FreshnessCheckResult {
  verdicts: FreshnessVerdict[]
  alerts: Array<{ owner: string; ago: number }>
  sent: boolean
  dryRun: boolean
}

// Orchestrate the check with injected IO (agoFn / state store / send) so the
// route stays a thin wire and the logic is hermetically testable.
export function runFreshnessCheck(deps: FreshnessCheckDeps): FreshnessCheckResult {
  const owners = deps.owners ?? FRESHNESS_OWNERS
  const threshold = deps.threshold ?? FRESHNESS_THRESHOLD_SECONDS
  const suppress = deps.suppressSeconds ?? FRESHNESS_REALERT_SUPPRESS_SECONDS
  const dryRun = deps.dryRun === true

  const verdicts = evaluateFreshness(owners, deps.agoFn, threshold)
  const state = dryRun ? {} : deps.loadState()
  const { alerts, nextState } = decideFreshnessAlerts(verdicts, state, deps.now, suppress)

  if (!dryRun) {
    for (const alert of alerts) deps.send(alert)
    deps.saveState(nextState)
  }

  return {
    verdicts,
    alerts: alerts.map((a) => ({ owner: a.owner, ago: a.ago })),
    sent: !dryRun && alerts.length > 0,
    dryRun,
  }
}
