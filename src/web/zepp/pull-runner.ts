// Zepp pull orchestrator (WELL-018).
// Wires creds -> auth -> pull (sleep/vitals/workouts) -> store write -> health-guard alerts.
// All steps are injected so the unit tests run fully without network or credentials.
//
// Silent-guard rule: a failed or partial pull writes a snapshot with the appropriate
// status. A broken pull MUST NOT be invisible -- the written snapshot surfaces
// the failure to Hibiki's consumer and to the health-guard alert path.

import type { ZeppTokens } from './auth.js'
import type { ZeppCredsOrToken } from './creds-reader.js'
import type { ZeppSleep, ZeppVitals, ZeppWorkout, ZeppDailySnapshot, ZeppPullStatus } from './contract.js'
import { checkSnapshot, type HealthGuardAlert } from './health-guard.js'
import { writeValidatedSnapshot } from './validated-ingest.js'
import type { PlausibilityViolation } from './health-plausibility.js'

export interface PullRunnerDeps {
  readCreds: () => Promise<ZeppCredsOrToken>
  login: (creds: ZeppCredsOrToken) => Promise<ZeppTokens>
  pullSleep: (date: string, token: string) => Promise<ZeppSleep | null>
  pullVitals: (date: string, token: string) => Promise<ZeppVitals | null>
  pullWorkouts: (date: string, token: string) => Promise<ZeppWorkout[]>
  writeSnapshot: (snap: ZeppDailySnapshot) => void
  // Persist the cross-field anomaly flag for the pulled day (WELL-027 WS1). Called with the
  // suspect-severity violations on every write; an empty list resolves an open flag.
  recordAnomaly: (date: string, suspect: PlausibilityViolation[]) => void
  onAlerts: (alerts: HealthGuardAlert[]) => void
  nowIso: () => string
}

export async function runZeppPull(date: string, deps: PullRunnerDeps): Promise<ZeppDailySnapshot> {
  const pulledAt = deps.nowIso()
  let status: ZeppPullStatus = 'ok'
  let error: string | undefined
  let sleep: ZeppSleep | undefined
  let vitals: ZeppVitals | undefined
  let workouts: ZeppWorkout[] | undefined

  try {
    const creds = await deps.readCreds()
    const tokens = await deps.login(creds)
    const token = tokens.accessToken

    const results = await Promise.allSettled([
      deps.pullSleep(date, token),
      deps.pullVitals(date, token),
      deps.pullWorkouts(date, token),
    ])

    const [sleepResult, vitalsResult, workoutsResult] = results
    let anyMissing = false
    let firstError: Error | undefined

    if (sleepResult.status === 'fulfilled') {
      sleep = sleepResult.value ?? undefined
      if (!sleep) anyMissing = true
    } else {
      firstError = firstError ?? (sleepResult.reason as Error)
      anyMissing = true
    }
    if (vitalsResult.status === 'fulfilled') {
      vitals = vitalsResult.value ?? undefined
      if (!vitals) anyMissing = true
    } else {
      firstError = firstError ?? (vitalsResult.reason as Error)
      anyMissing = true
    }
    if (workoutsResult.status === 'fulfilled') {
      workouts = workoutsResult.value
    } else {
      firstError = firstError ?? (workoutsResult.reason as Error)
      anyMissing = true
    }

    if (firstError) {
      const errType: string = (firstError as any).type ?? 'endpoint_error'
      status = errType === 'auth_fail' ? 'auth_fail' : 'endpoint_error'
      error = firstError.message
    } else if (anyMissing) {
      status = 'partial'
    }
  } catch (err) {
    const errType: string = (err as any).type ?? 'endpoint_error'
    status = errType === 'auth_fail' ? 'auth_fail' : 'endpoint_error'
    error = err instanceof Error ? err.message : String(err)
  }

  const snapshot: ZeppDailySnapshot = {
    date,
    pulledAt,
    status,
    ...(sleep !== undefined && { sleep }),
    ...(vitals !== undefined && { vitals }),
    ...(workouts !== undefined && { workouts }),
    ...(error !== undefined && { error }),
  }

  // Always write -- a failed pull must be visible (silent-guard discipline). Route through the
  // shared validated funnel so the pull path persists an anomaly flag too (WELL-027 WS1), not
  // just the log-only alert below.
  writeValidatedSnapshot(snapshot, {
    writeSnapshot: deps.writeSnapshot,
    recordAnomaly: deps.recordAnomaly,
  })

  const alerts = checkSnapshot(snapshot, new Date(pulledAt).getTime())
  if (alerts.length > 0) {
    deps.onAlerts(alerts)
  }

  return snapshot
}

// Default deps wiring for production use.
import { readZeppCredsOrToken, resolveDefaultCredsPath } from './creds-reader.js'
import { zeppLoginOrToken, DEFAULT_AUTH_CONFIG } from './auth.js'
import { pullSleep, pullVitals, pullWorkouts, DEFAULT_API_BASE_URL, regionToApiBase, type ZeppAuthStyle } from './puller.js'
import { defaultZeppStore } from './ingest-store.js'
import { defaultZeppAnomalyStore } from './anomaly-store.js'
import { logger } from '../../logger.js'

export function makeDefaultPullRunnerDeps(): PullRunnerDeps {
  // Config derived from the creds each run: token-mode => apptoken header on the
  // region host with userid; password-mode => Bearer on the default host. Set by
  // readCreds (always called before the pulls in runZeppPull) and read by the
  // pull closures below.
  let cfg: { apiBaseUrl: string; userid?: string; authStyle: ZeppAuthStyle } = {
    apiBaseUrl: DEFAULT_API_BASE_URL,
    authStyle: 'bearer',
  }
  const fetch = globalThis.fetch
  return {
    readCreds: async () => {
      const creds = readZeppCredsOrToken(resolveDefaultCredsPath())
      cfg = creds.mode === 'token'
        ? {
            apiBaseUrl: creds.region ? regionToApiBase(creds.region) : DEFAULT_API_BASE_URL,
            userid: creds.userid,
            authStyle: 'apptoken',
          }
        : { apiBaseUrl: DEFAULT_API_BASE_URL, authStyle: 'bearer' }
      return creds
    },
    login: (creds) => zeppLoginOrToken(creds, { ...DEFAULT_AUTH_CONFIG, fetch }),
    pullSleep: (date, token) => pullSleep(date, { apiBaseUrl: cfg.apiBaseUrl, accessToken: token, fetch, userid: cfg.userid, authStyle: cfg.authStyle }),
    pullVitals: (date, token) => pullVitals(date, { apiBaseUrl: cfg.apiBaseUrl, accessToken: token, fetch, userid: cfg.userid, authStyle: cfg.authStyle }),
    pullWorkouts: (date, token) => pullWorkouts(date, { apiBaseUrl: cfg.apiBaseUrl, accessToken: token, fetch, userid: cfg.userid, authStyle: cfg.authStyle }),
    writeSnapshot: (snap) => defaultZeppStore.write(snap),
    recordAnomaly: (date, suspect) => {
      defaultZeppAnomalyStore.record(date, suspect, new Date().toISOString())
    },
    onAlerts: (alerts) => {
      for (const a of alerts) {
        logger.warn({ alert: a }, `zepp health-guard: ${a.type} on ${a.date} -- ${a.message}`)
      }
    },
    nowIso: () => new Date().toISOString(),
  }
}
