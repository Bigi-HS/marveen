// Token-outage Layer-1 survival: health-check + reminder-fire (card e97be470).
//
// Complements token-outage-bridge.ts (which handles the ACK + re-dispatch for
// the main orchestrator). This module adds two deterministic survival behaviours
// that run ONLY while the Claude account is in outage, using ZERO LLM calls:
//
//   HEALTH-CHECK  -- sweep key tmux sessions + dashboard HTTP; send one alert on
//                    the first cycle that finds a new issue (de-duped vs last
//                    alert, so a continuous outage does not spam every 30s).
//   REMINDER-FIRE -- query noa.db scheduled_tasks for overdue tasks; deliver a
//                    direct Bot-API message per task so time-sensitive reminders
//                    are not silently dropped during the outage window.
//
// Both sides use only Node stdlib (http, child_process) -- no openai SDK, no
// LLM round-trip. (B1 lesson: survival-layer must be stdlib-only.)

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { getNoaDb } from '../noa-db.js'
import { readChannelToken, channelStateDir } from '../channel-provider.js'

const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()
const STORE = join(PROJECT_ROOT, 'store')
const SURVIVAL_STATE_PATH = join(STORE, 'token-outage-survival-state.json')
const OUTAGE_STATE_PATH = join(STORE, 'token-outage-state.json')
const ALERT_CHAT_ID = process.env.WATCHDOG_ALERT_CHAT_ID ?? '8643929442'

// Escalate-once-then-backoff for a PERSISTENT health issue. The first alert for a
// new issue-set fires immediately; each subsequent repeat of the SAME set waits an
// exponentially growing interval (base * factor^(n-1)) capped at MAX. A genuinely
// new issue resets the backoff and re-alerts at once. This replaces the old fixed
// 5-min throttle, whose `|| throttleExpired` re-fired the same stuck issue every
// 5 min for the whole outage (incident 2026-08-22: ~100x spam over 9h).
const HEALTH_ALERT_BASE_MS = 5 * 60 * 1000
const HEALTH_ALERT_BACKOFF_FACTOR = 3
const HEALTH_ALERT_MAX_MS = 2 * 60 * 60 * 1000

// Key tmux sessions to probe during an outage.
const KEY_SESSIONS = ['marveen', 'marveen-channels', 'agent-dave', 'agent-thor']

export interface OverdueTask {
  id: string
  name: string
  description: string
  agent: string
}

export interface SurvivalState {
  notifiedTaskIds: string[]
  lastHealthIssues: string[]
  lastHealthAlertTs: number
  // Number of consecutive alerts already sent for the CURRENT issue-set; drives the
  // backoff interval. Optional for backward-compat with pre-migration state files.
  healthAlertCount?: number
}

export interface SurvivalResult {
  skipped: boolean       // true when not in outage
  healthIssues: string[]
  healthAlertSent: boolean
  remindersDelivered: number
}

export interface SurvivalDeps {
  isLimited: () => boolean
  checkHealth: () => Promise<string[]>
  getOverdueTasks: () => OverdueTask[]
  sendAlert: (text: string) => Promise<boolean>
  readState: () => SurvivalState
  writeState: (s: SurvivalState) => void
  nowMs: () => number
}

// ---- pure helpers ---------------------------------------------------------

function emptyState(): SurvivalState {
  return { notifiedTaskIds: [], lastHealthIssues: [], lastHealthAlertTs: 0, healthAlertCount: 0 }
}

// Returns true only when issues contain something not already in lastKnown.
export function hasNewIssues(issues: string[], lastKnown: string[]): boolean {
  const known = new Set(lastKnown)
  return issues.some((i) => !known.has(i))
}

// Interval to wait before the next repeat alert, given how many alerts have already
// been sent for the current issue-set. base * factor^(n-1), capped at MAX.
export function healthAlertBackoffMs(alertsSent: number): number {
  const n = Math.max(1, alertsSent)
  const ms = HEALTH_ALERT_BASE_MS * Math.pow(HEALTH_ALERT_BACKOFF_FACTOR, n - 1)
  return Math.min(ms, HEALTH_ALERT_MAX_MS)
}

// ---- default IO -----------------------------------------------------------

function defaultIsLimited(): boolean {
  try {
    const raw = readFileSync(OUTAGE_STATE_PATH, 'utf8')
    return (JSON.parse(raw) as { limited?: boolean }).limited === true
  } catch {
    return false
  }
}

function checkTmuxSession(name: string): boolean {
  const r = spawnSync('tmux', ['has-session', '-t', `=${name}`], {
    timeout: 3000,
    env: { ...process.env, TMUX: undefined } as NodeJS.ProcessEnv,
  })
  return r.status === 0
}

function checkDashboard(port = 3420): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: 4000 },
      (res) => resolve(res.statusCode !== undefined && res.statusCode < 500),
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

async function defaultCheckHealth(): Promise<string[]> {
  const issues: string[] = []
  const dashOk = await checkDashboard().catch(() => false)
  if (!dashOk) issues.push('dashboard:down')
  for (const s of KEY_SESSIONS) {
    if (!checkTmuxSession(s)) issues.push(`session:${s}:down`)
  }
  return issues
}

function defaultGetOverdueTasks(): OverdueTask[] {
  try {
    const db = getNoaDb()
    const nowSec = Math.floor(Date.now() / 1000)
    const rows = db.prepare(
      `SELECT id, name, COALESCE(description,'') AS description, COALESCE(agent,'') AS agent
       FROM scheduled_tasks
       WHERE status='active' AND next_run <= ?
       ORDER BY next_run ASC LIMIT 10`,
    ).all(nowSec) as OverdueTask[]
    return rows
  } catch (err) {
    logger.warn({ err }, 'token-outage-survival: failed to query overdue tasks')
    return []
  }
}

function readMainToken(): string | null {
  try {
    const tokenPath = join(channelStateDir('telegram', undefined), '.env')
    return readChannelToken('telegram', tokenPath) || null
  } catch {
    return null
  }
}

async function defaultSendAlert(text: string): Promise<boolean> {
  const token = readMainToken()
  if (!token) return false
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: ALERT_CHAT_ID, text })
    const req = httpsRequest(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 8000,
      },
      (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.write(body)
    req.end()
  })
}

function defaultReadState(): SurvivalState {
  try {
    return JSON.parse(readFileSync(SURVIVAL_STATE_PATH, 'utf8')) as SurvivalState
  } catch {
    return emptyState()
  }
}

function defaultWriteState(s: SurvivalState): void {
  try {
    writeFileSync(SURVIVAL_STATE_PATH, JSON.stringify(s, null, 2))
  } catch (err) {
    logger.warn({ err }, 'token-outage-survival: failed to write state')
  }
}

const DEFAULT_DEPS: SurvivalDeps = {
  isLimited: defaultIsLimited,
  checkHealth: () => defaultCheckHealth(),
  getOverdueTasks: defaultGetOverdueTasks,
  sendAlert: defaultSendAlert,
  readState: defaultReadState,
  writeState: defaultWriteState,
  nowMs: () => Date.now(),
}

// ---- main cycle -----------------------------------------------------------

export async function runSurvivalCycle(deps: SurvivalDeps = DEFAULT_DEPS): Promise<SurvivalResult> {
  if (!deps.isLimited()) {
    // Not in outage: clear survival state so next outage starts fresh.
    const state = deps.readState()
    if (state.notifiedTaskIds.length > 0) {
      deps.writeState({
        ...emptyState(),
        lastHealthIssues: state.lastHealthIssues,
        lastHealthAlertTs: state.lastHealthAlertTs,
        healthAlertCount: state.healthAlertCount ?? 0,
      })
    }
    return { skipped: true, healthIssues: [], healthAlertSent: false, remindersDelivered: 0 }
  }

  const now = deps.nowMs()
  const state = { ...deps.readState() }
  let healthAlertSent = false
  let remindersDelivered = 0

  // --- health check ---
  const issues = await Promise.resolve(deps.checkHealth())
  const issuesChanged = hasNewIssues(issues, state.lastHealthIssues)
  const alertsSent = state.healthAlertCount ?? 0
  const backoffExpired = now - state.lastHealthAlertTs >= healthAlertBackoffMs(alertsSent)
  if (issues.length > 0 && (issuesChanged || backoffExpired)) {
    const text = `[Health-check token-outage] Problemak:\n${issues.map((i) => `- ${i}`).join('\n')}`
    healthAlertSent = await deps.sendAlert(text).catch(() => false)
    if (healthAlertSent) {
      state.lastHealthIssues = issues
      state.lastHealthAlertTs = now
      // A new issue restarts the backoff; a repeat of the same set advances it.
      state.healthAlertCount = issuesChanged ? 1 : alertsSent + 1
    }
  } else if (issues.length === 0) {
    state.lastHealthIssues = []
    state.healthAlertCount = 0
  }

  // --- reminder fire ---
  const notifiedSet = new Set(state.notifiedTaskIds)
  const overdue = deps.getOverdueTasks().filter((t) => !notifiedSet.has(t.id))
  for (const task of overdue) {
    const text =
      `[Scheduled reminder - token-outage direct delivery]\n` +
      `Task: ${task.name}` +
      (task.description ? `\n${task.description}` : '') +
      `\n(Agent: ${task.agent || 'N/A'} - LLM unavailable, direct delivery)`
    const sent = await deps.sendAlert(text).catch(() => false)
    if (sent) {
      notifiedSet.add(task.id)
      remindersDelivered++
    }
  }
  state.notifiedTaskIds = [...notifiedSet]
  deps.writeState(state)

  return { skipped: false, healthIssues: issues, healthAlertSent, remindersDelivered }
}
