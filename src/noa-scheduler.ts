import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { CronExpressionParser } from 'cron-parser'
import { logger } from './logger.js'
import { MAIN_AGENT_ID, ALLOWED_CHAT_ID, PROJECT_ROOT } from './config.js'
import { getNoaDb } from './noa-db.js'
import { UNTRUSTED_PREAMBLE, wrapUntrusted } from './prompt-safety.js'
import { SCHEDULED_TASKS_DIR, parseSkillMdFrontmatter } from './web/scheduled-tasks-io.js'
import {
  agentSessionName,
  isSessionReadyForPrompt,
  sendPromptToSession,
} from './web/agent-process.js'
import { MAIN_CHANNELS_SESSION } from './web/main-agent.js'
import { resolveFromPath } from './platform.js'

// Lazy tmux path -- resolved on first use so module load never throws if tmux absent in test env
let _tmux: string | null = null
function getTmux(): string {
  if (!_tmux) _tmux = resolveFromPath('tmux')
  return _tmux
}

const TZ = 'Europe/Budapest'
export const MAX_SCHEDULED_TASK_PROMPT_LEN = 50_000
export const CRON_SHAPE_RX = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/

// ---------------------------------------------------------------------------
// Error types (AC-1)
// ---------------------------------------------------------------------------

export class InvalidIdError extends Error {
  constructor(id: string) { super(`Invalid task id: "${id}"`); this.name = 'InvalidIdError' }
}
export class DuplicateTaskIdError extends Error {
  constructor(id: string) { super(`Task id already exists: "${id}"`); this.name = 'DuplicateTaskIdError' }
}
export class InvalidScheduleError extends Error {
  constructor(s: string) { super(`Invalid cron schedule: "${s}"`); this.name = 'InvalidScheduleError' }
}
export class PromptTooLongError extends Error {
  constructor(len: number) { super(`Prompt too long: ${len} chars (max ${MAX_SCHEDULED_TASK_PROMPT_LEN})`); this.name = 'PromptTooLongError' }
}
export class InvalidTypeError extends Error {
  constructor(t: unknown) { super(`Invalid task type: "${t}"`); this.name = 'InvalidTypeError' }
}
export class InvalidAgentError extends Error {
  constructor(agent?: unknown) {
    super(agent !== undefined
      ? `Invalid agent name: "${agent}" (only [a-z0-9-] allowed)`
      : 'Agent must be a non-empty string')
    this.name = 'InvalidAgentError'
  }
}
export class TaskNotFoundError extends Error {
  constructor(id: string) { super(`Task not found: "${id}"`); this.name = 'TaskNotFoundError' }
}

// ---------------------------------------------------------------------------
// ScheduledTask interface (id, not name; no enabled field; B-block cols present)
// ---------------------------------------------------------------------------

export interface ScheduledTask {
  id: string
  agent: string
  type: 'task' | 'heartbeat'
  description: string
  prompt: string
  schedule: string
  next_run: number
  last_run: number | null
  last_result: string | null
  status: 'active' | 'paused' | 'deleted'
  created_at: number
  skip_if_busy: number
  force_send: number
  direct_send: number
  layer2: number
  target_session: string | null
  card_id: string | null
}

// ---------------------------------------------------------------------------
// B-block columns (OQ-1): added as additive DDL at module init
// ---------------------------------------------------------------------------

const BBLOCK_COLUMNS = [
  `ALTER TABLE scheduled_tasks ADD COLUMN skip_if_busy  INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE scheduled_tasks ADD COLUMN force_send    INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE scheduled_tasks ADD COLUMN direct_send   INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE scheduled_tasks ADD COLUMN layer2        INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE scheduled_tasks ADD COLUMN target_session TEXT`,
  `ALTER TABLE scheduled_tasks ADD COLUMN card_id        TEXT`,
]

export function applyBBlockColumns(db = getNoaDb()): void {
  for (const stmt of BBLOCK_COLUMNS) {
    try { db.exec(stmt) } catch { /* column already exists -- ok */ }
  }
}

// ---------------------------------------------------------------------------
// Cron helpers (AC-3): TZ option on EVERY parse call
// ---------------------------------------------------------------------------

// Resolve the next cron occurrence strictly after `fromMs`. The basis is
// parametrized (default: wall clock) so the sweep can roll a fired task forward
// from its scheduled slot rather than from "now": when a task fires inside the
// look-ahead window (next_run is still seconds in the future), a Date.now() basis
// re-resolves to the SAME slot and the task self-refires on the next tick (295c94f2).
export function computeNextRun(schedule: string, fromMs: number = Date.now()): number {
  const expr = CronExpressionParser.parse(schedule, { tz: TZ, currentDate: new Date(fromMs) })
  return Math.floor(expr.next().getTime() / 1000)
}

export function isValidCronShape(cron: unknown): cron is string {
  if (typeof cron !== 'string') return false
  const trimmed = cron.trim()
  if (!trimmed || trimmed.length > 100) return false
  if (!CRON_SHAPE_RX.test(trimmed)) return false
  try {
    CronExpressionParser.parse(trimmed, { tz: TZ }).next()
    return true
  } catch { return false }
}

export function cronMatchesNow(schedule: string, catchUpMs: number = 60000): boolean {
  try {
    const expr = CronExpressionParser.parse(schedule, { tz: TZ })
    const prev = expr.prev()
    return (Date.now() - prev.getTime()) < catchUpMs
  } catch { return false }
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

function validateId(id: string): void {
  if (!KEBAB_RE.test(id)) throw new InvalidIdError(id)
}

function validateType(type: unknown): void {
  if (type !== 'task' && type !== 'heartbeat') throw new InvalidTypeError(type)
}

// Agent name charset: only [a-z0-9-] (kebab) to block tmux metacharacters (Chad #292).
const AGENT_RE = /^[a-z0-9][a-z0-9-]*$/
function validateAgent(agent: unknown): void {
  if (typeof agent !== 'string' || !agent.trim()) throw new InvalidAgentError()
  if (!AGENT_RE.test(agent)) throw new InvalidAgentError(agent)
}

function validatePromptLen(prompt: string): void {
  if (prompt.length > MAX_SCHEDULED_TASK_PROMPT_LEN) throw new PromptTooLongError(prompt.length)
}

function validateSchedule(schedule: unknown): void {
  if (!isValidCronShape(schedule)) throw new InvalidScheduleError(String(schedule))
}

// ---------------------------------------------------------------------------
// appendTaskRun (OQ-2: local fn, uses getNoaDb() -- no separate module)
// ---------------------------------------------------------------------------

function appendTaskRun(name: string, agent: string, db = getNoaDb()): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare('INSERT INTO task_runs (name, agent, ts) VALUES (?, ?, ?)').run(name, agent, now)
}

// ---------------------------------------------------------------------------
// pending_task_retries helpers (noa.db via getNoaDb)
// ---------------------------------------------------------------------------

type PendingRetryRow = {
  task_name: string
  agent_name: string
  first_attempt: number
  last_attempt: number
  attempt_count: number
  last_reason: string | null
}

function insertPendingRetryIfNew(
  taskName: string, agentName: string, nowS: number, reason: string, db = getNoaDb()
): void {
  db.prepare(`
    INSERT OR IGNORE INTO pending_task_retries
      (task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(taskName, agentName, nowS, nowS, reason)
}

function updatePendingRetry(
  taskName: string, agentName: string, nowS: number, reason: string, db = getNoaDb()
): boolean {
  const info = db.prepare(`
    UPDATE pending_task_retries
    SET last_attempt=?, attempt_count=attempt_count+1, last_reason=?
    WHERE task_name=? AND agent_name=?
  `).run(nowS, reason, taskName, agentName)
  return info.changes > 0
}

function listPendingRetries(db = getNoaDb()): PendingRetryRow[] {
  return db.prepare(
    'SELECT * FROM pending_task_retries ORDER BY first_attempt ASC'
  ).all() as PendingRetryRow[]
}

function deletePendingRetry(taskName: string, agentName: string, db = getNoaDb()): void {
  db.prepare(
    'DELETE FROM pending_task_retries WHERE task_name=? AND agent_name=?'
  ).run(taskName, agentName)
}

// ---------------------------------------------------------------------------
// CRUD (AC-1, AC-2)
// ---------------------------------------------------------------------------

export interface CreateTaskParams {
  id: string
  agent: string
  type: 'task' | 'heartbeat'
  prompt: string
  schedule: string
  description?: string
  status?: 'active' | 'paused'
}

export function createTask(params: CreateTaskParams, db = getNoaDb()): ScheduledTask {
  validateId(params.id)
  validateAgent(params.agent)
  validateType(params.type)
  validateSchedule(params.schedule)
  validatePromptLen(params.prompt)

  const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(params.id)
  if (existing) throw new DuplicateTaskIdError(params.id)

  const now = Math.floor(Date.now() / 1000)
  const nextRun = computeNextRun(params.schedule)
  const status = params.status ?? 'active'
  const description = params.description ?? ''

  db.prepare(`
    INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(params.id, params.agent, params.type, description, params.prompt, params.schedule, nextRun, status, now)

  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(params.id) as ScheduledTask
}

export interface UpdateTaskPatch {
  description?: string
  prompt?: string
  schedule?: string
  agent?: string
  type?: 'task' | 'heartbeat'
  status?: 'active' | 'paused'
}

export function updateTask(id: string, patch: UpdateTaskPatch, db = getNoaDb()): ScheduledTask {
  const existing = db.prepare(
    `SELECT * FROM scheduled_tasks WHERE id = ? AND status != 'deleted'`
  ).get(id) as ScheduledTask | undefined
  if (!existing) throw new TaskNotFoundError(id)

  if (patch.agent !== undefined) validateAgent(patch.agent)
  if (patch.type !== undefined) validateType(patch.type)
  if (patch.schedule !== undefined) validateSchedule(patch.schedule)
  if (patch.prompt !== undefined) validatePromptLen(patch.prompt)

  const sets: string[] = []
  const values: unknown[] = []

  if (patch.description !== undefined) { sets.push('description=?'); values.push(patch.description) }
  if (patch.prompt !== undefined) { sets.push('prompt=?'); values.push(patch.prompt) }
  if (patch.schedule !== undefined) {
    const nextRun = computeNextRun(patch.schedule)
    sets.push('schedule=?', 'next_run=?')
    values.push(patch.schedule, nextRun)
  }
  if (patch.agent !== undefined) { sets.push('agent=?'); values.push(patch.agent) }
  if (patch.type !== undefined) { sets.push('type=?'); values.push(patch.type) }
  if (patch.status !== undefined) { sets.push('status=?'); values.push(patch.status) }

  if (sets.length > 0) {
    values.push(id)
    db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id=?`).run(...values)
  }

  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask
}

export function deleteTask(id: string, db = getNoaDb()): ScheduledTask {
  const existing = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask | undefined
  if (!existing) throw new TaskNotFoundError(id)
  db.prepare(`UPDATE scheduled_tasks SET status='deleted' WHERE id=?`).run(id)
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTask
}

// Idempotent UPSERT: INSERT if new, UPDATE (revive) if exists (any status incl. deleted).
// Called by /api/schedules CRUD to keep noa.db in sync with the file-store during dual-write.
export function syncTaskToNoa(params: CreateTaskParams, db = getNoaDb()): ScheduledTask {
  validateId(params.id)
  validateAgent(params.agent)
  validateType(params.type)
  validateSchedule(params.schedule)
  validatePromptLen(params.prompt)

  const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(params.id)
  const now = Math.floor(Date.now() / 1000)
  const nextRun = computeNextRun(params.schedule)
  const status = params.status ?? 'active'
  const description = params.description ?? ''

  if (!existing) {
    db.prepare(`
      INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(params.id, params.agent, params.type, description, params.prompt, params.schedule, nextRun, status, now)
  } else {
    db.prepare(`
      UPDATE scheduled_tasks
      SET agent = ?, type = ?, description = ?, prompt = ?, schedule = ?, status = ?, next_run = ?
      WHERE id = ?
    `).run(params.agent, params.type, description, params.prompt, params.schedule, status, nextRun, params.id)
  }

  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(params.id) as ScheduledTask
}

// Soft-delete from noa.db. No-op if the id does not exist (tolerates file-only legacy tasks).
export function removeTaskFromNoa(id: string, db = getNoaDb()): void {
  const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(id)
  if (!existing) return
  db.prepare(`UPDATE scheduled_tasks SET status = 'deleted' WHERE id = ?`).run(id)
}

export function getTask(id: string, db = getNoaDb()): ScheduledTask | null {
  return (db.prepare(
    'SELECT * FROM scheduled_tasks WHERE id = ?'
  ).get(id) as ScheduledTask | undefined) ?? null
}

export function listTasks(filter?: { status?: 'active' | 'paused' }, db = getNoaDb()): ScheduledTask[] {
  if (filter?.status) {
    return db.prepare(
      `SELECT * FROM scheduled_tasks WHERE status = ? ORDER BY created_at DESC`
    ).all(filter.status) as ScheduledTask[]
  }
  return db.prepare(
    `SELECT * FROM scheduled_tasks WHERE status != 'deleted' ORDER BY created_at DESC`
  ).all() as ScheduledTask[]
}

// ---------------------------------------------------------------------------
// Prompt builder (AC-5): verbatim from schedule-runner.ts; task.name -> task.id
// ---------------------------------------------------------------------------

export function buildScheduledTaskPrompt(task: ScheduledTask, agentName: string): string {
  let prefix: string
  if (task.type === 'heartbeat') {
    if (agentName === 'heartbeat') {
      prefix = `[Heartbeat: ${task.id}] `
    } else {
      prefix = `[Heartbeat: ${task.id}] *** KOTELEZO ELSO TEENDO MIELOTT BARMIT IRSZ: hivj meg pontosan EGY local-only tool-t (peldaul Bash 'echo keepalive >> /tmp/marveen-keepalive.log' VAGY Read tool egy meglevo fajlra mint ${join(PROJECT_ROOT, 'HEARTBEAT.md')}). NE Telegram-tool-t -- az zajt eredmenyezne. Ezt a Telegram-bun MCP-stdio-pipe keep-alive-ehez kell, ha kihagyod, a Telegram-conn 30 percen belul disconnect-el. *** Aztan: ez egy csendes ellenorzes. CSAK AKKOR irj Telegramon (chat_id: ${ALLOWED_CHAT_ID}), ha tenyleg fontos/surgos dolgot talalsz. Ha minden rendben, NE kuldj Telegram uzenetet -- a kotelezo no-op tool-call mar megfelelo aktivitas. Egy rovid 'csendes heartbeat' sor a transzkriptbe + a tool-call elég. `
    }
  } else {
    prefix = `[Utemezett feladat: ${task.id}] Az eredmenyt kuldd el Telegramon (chat_id: ${ALLOWED_CHAT_ID}, reply tool). `
  }
  return (
    UNTRUSTED_PREAMBLE + '\n' +
    prefix.trimEnd() + '\n\n' +
    wrapUntrusted(`scheduled-task:${task.id}`, task.prompt)
  )
}

// ---------------------------------------------------------------------------
// attemptFireTask (AC-11)
// ---------------------------------------------------------------------------

type FireResult = 'fired' | 'busy' | 'missing' | 'error'

// Snapshot the live tmux session names once. Resolved at the top of a sweep tick
// and shared across every attemptFireTask call so we spawn `tmux list-sessions`
// once per tick instead of once per due task. A session that dies mid-tick still
// degrades gracefully: the subsequent isSessionReadyForPrompt (live capture-pane)
// returns false -> 'busy' -> retry next tick.
function listTmuxSessions(): Set<string> {
  try {
    const out = execFileSync(
      getTmux(), ['list-sessions', '-F', '#{session_name}'],
      { timeout: 3000, encoding: 'utf-8' }
    )
    return new Set(out.split('\n').map(s => s.trim()).filter(Boolean))
  } catch {
    return new Set() // no tmux or no sessions
  }
}

function attemptFireTask(
  task: ScheduledTask,
  agentName: string,
  sessions: Set<string>,
  db = getNoaDb(),
): FireResult {
  const isMainAgent = agentName === MAIN_AGENT_ID
  // target_session is a B-block column: stored during migration but inert in A4 sweep.
  const session = isMainAgent ? MAIN_CHANNELS_SESSION : agentSessionName(agentName)

  if (!sessions.has(session)) {
    logger.warn({ task: task.id, agent: agentName, session }, 'scheduler: target session not running, skipping')
    return 'missing'
  }

  if (!isSessionReadyForPrompt(session)) {
    logger.warn({ task: task.id, agent: agentName, session }, 'scheduler: target session busy, will retry')
    return 'busy'
  }

  try {
    const fullPrompt = buildScheduledTaskPrompt(task, agentName)
    sendPromptToSession(session, fullPrompt)
    appendTaskRun(task.id, agentName, db)
    logger.info({ task: task.id, agent: agentName, session }, 'scheduler: task fired')

    // Post-send resubmit: verbatim from schedule-runner.ts (AC-5)
    const marker = task.type === 'heartbeat'
      ? `[Heartbeat: ${task.id}]`
      : `[Utemezett feladat: ${task.id}]`
    const resubmit = (attempt: number) => {
      try {
        const pane = execFileSync(
          getTmux(), ['capture-pane', '-t', session, '-p'],
          { timeout: 3000, encoding: 'utf-8' }
        )
        const stuck = /❯\s+\S/.test(pane) && pane.includes(marker)
        if (!stuck) return
        if (attempt >= 5) {
          logger.warn({ task: task.id, session }, 'scheduler: prompt stuck after 5 Enter retries -- giving up')
          return
        }
        execFileSync(getTmux(), ['send-keys', '-t', session, 'Enter'], { timeout: 3000 })
        setTimeout(() => resubmit(attempt + 1), 3000)
      } catch (err) {
        logger.warn({ err, task: task.id }, 'scheduler: post-send resubmit failed')
      }
    }
    setTimeout(() => resubmit(0), 2000)
    return 'fired'
  } catch (err) {
    logger.warn({ err, task: task.id }, 'scheduler: failed to fire task')
    return 'error'
  }
}

// ---------------------------------------------------------------------------
// File-to-DB migration (AC-7)
// ---------------------------------------------------------------------------

function readFileSafe(path: string): string {
  try { return readFileSync(path, 'utf-8') } catch { return '' }
}

export function migrateFileBasedTasks(db = getNoaDb(), tasksDir = SCHEDULED_TASKS_DIR): void {
  const sentinel = db.prepare(
    `SELECT id FROM scheduled_tasks WHERE id = ?`
  ).get('__file_migration_done')
  if (sentinel) return

  let imported = 0

  if (existsSync(tasksDir)) {
    let dirs: string[] = []
    try {
      dirs = readdirSync(tasksDir).filter(f => {
        try { return statSync(join(tasksDir, f)).isDirectory() } catch { return false }
      })
    } catch (err) {
      logger.warn({ err }, 'scheduler: error reading scheduled-tasks dir during migration')
    }

    for (const d of dirs) {
      try {
        // Read directly from tasksDir (not the global SCHEDULED_TASKS_DIR)
        const taskDir = join(tasksDir, d)
        const skillPath = join(taskDir, 'SKILL.md')
        const configPath = join(taskDir, 'task-config.json')
        if (!existsSync(skillPath)) continue

        const skillContent = readFileSafe(skillPath)
        const { name, description, body } = parseSkillMdFrontmatter(skillContent)
        const taskId = name || d

        let config: {
          schedule?: string; agent?: string; enabled?: boolean; createdAt?: number
          type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string
          directSend?: boolean; cardId?: string; layer2?: boolean
        } = {}
        try { config = JSON.parse(readFileSafe(configPath)) } catch { /* use defaults */ }

        const schedule = config.schedule || '0 9 * * *'
        const task = {
          name: taskId,
          description: description || '',
          prompt: body,
          schedule,
          agent: config.agent || MAIN_AGENT_ID,
          enabled: config.enabled !== false,
          createdAt: config.createdAt || 0,
          type: (config.type as 'task' | 'heartbeat') || 'task',
          skipIfBusy: config.skipIfBusy === true,
          forceSend: config.forceSend === true,
          directSend: config.directSend === true,
          layer2: config.layer2 === true,
          targetSession: config.targetSession,
          cardId: config.cardId,
        }

        if (!isValidCronShape(task.schedule)) {
          logger.warn({ task: task.name }, 'scheduler: skipping file task with invalid cron during migration')
          continue
        }

        const status = task.enabled ? 'active' : 'paused'
        const nextRun = computeNextRun(task.schedule)
        const createdAt = task.createdAt || Math.floor(Date.now() / 1000)

        const info = db.prepare(`
          INSERT OR IGNORE INTO scheduled_tasks
            (id, agent, type, description, prompt, schedule, next_run, status, created_at,
             skip_if_busy, force_send, direct_send, layer2, target_session, card_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          task.name,
          task.agent,
          task.type,
          task.description,
          task.prompt,
          task.schedule,
          nextRun,
          status,
          createdAt,
          task.skipIfBusy ? 1 : 0,
          task.forceSend ? 1 : 0,
          task.directSend ? 1 : 0,
          task.layer2 ? 1 : 0,
          task.targetSession ?? null,
          task.cardId ?? null,
        )
        if (info.changes > 0) imported++
      } catch (err) {
        logger.warn({ err, dir: d }, 'scheduler: failed to import file task during migration')
      }
    }
  }

  // Sentinel via raw SQL -- id '__file_migration_done' contains underscores, bypasses kebab validator
  const nowTs = Math.floor(Date.now() / 1000)
  db.exec(
    `INSERT OR IGNORE INTO scheduled_tasks (id, agent, type, description, prompt, schedule, next_run, status, created_at)` +
    ` VALUES ('__file_migration_done', '', 'task', 'migration sentinel', '', '0 0 1 1 *', 9999999999, 'deleted', ${nowTs})`
  )

  logger.info(`scheduler: file migration complete, ${imported} tasks imported`)
}

// ---------------------------------------------------------------------------
// Sweep tick (exported for testability)
// ---------------------------------------------------------------------------

export function runSweepTick(catchUpMs: number, db = getNoaDb()): void {
  const nowMs = Date.now()
  const nowS = Math.floor(nowMs / 1000)
  const catchUpS = Math.floor(catchUpMs / 1000)

  // Resolve the live tmux session set once for the whole tick (see listTmuxSessions).
  const sessions = listTmuxSessions()

  // Step 1: retry pending rows
  const pendingRows = listPendingRetries(db)
  const pendingKeys = new Set<string>()

  for (const row of pendingRows) {
    const taskDef = getTask(row.task_name, db)
    if (!taskDef || taskDef.status === 'deleted' || taskDef.status !== 'active') {
      deletePendingRetry(row.task_name, row.agent_name, db)
      continue
    }

    const key = `${row.task_name}@${row.agent_name}`
    pendingKeys.add(key)

    const result = attemptFireTask(taskDef, row.agent_name, sessions, db)
    if (result === 'fired') {
      // Roll forward from the fired slot, not from "now" -- a look-ahead fire is
      // still before its cron minute and a now-basis would re-pick the same slot (295c94f2).
      const basisMs = Math.max(nowMs, taskDef.next_run * 1000)
      db.prepare(
        `UPDATE scheduled_tasks SET last_run=?, last_result='fired', next_run=? WHERE id=?`
      ).run(nowS, computeNextRun(taskDef.schedule, basisMs), taskDef.id)
      deletePendingRetry(row.task_name, row.agent_name, db)
    } else if (result === 'missing') {
      deletePendingRetry(row.task_name, row.agent_name, db)
    } else {
      updatePendingRetry(row.task_name, row.agent_name, nowS, result, db)
    }
  }

  // Step 2: cron sweep
  const windowEnd = nowS + catchUpS
  const dueTasks = db.prepare(`
    SELECT * FROM scheduled_tasks
    WHERE status='active' AND next_run <= ?
      AND (last_run IS NULL OR last_run < next_run)
    ORDER BY next_run ASC
  `).all(windowEnd) as ScheduledTask[]

  for (const task of dueTasks) {
    const agentName = task.agent || MAIN_AGENT_ID
    const key = `${task.id}@${agentName}`
    if (pendingKeys.has(key)) continue

    const result = attemptFireTask(task, agentName, sessions, db)

    if (result === 'fired') {
      // See Step 1: base the roll-forward on the fired slot to avoid look-ahead self-refire (295c94f2).
      const basisMs = Math.max(nowMs, task.next_run * 1000)
      db.prepare(
        `UPDATE scheduled_tasks SET last_run=?, last_result='fired', next_run=? WHERE id=?`
      ).run(nowS, computeNextRun(task.schedule, basisMs), task.id)
    } else if (result === 'busy') {
      insertPendingRetryIfNew(task.id, agentName, nowS, 'busy', db)
    } else if (result === 'missing') {
      logger.warn({ task: task.id, agent: agentName }, 'scheduler: session missing, skipping (no retry)')
    } else if (result === 'error') {
      logger.warn({ task: task.id, agent: agentName }, 'scheduler: fire error, will retry on next cron match')
    }
  }
}

// ---------------------------------------------------------------------------
// Sweep runner (AC-4)
// ---------------------------------------------------------------------------

export function startScheduleRunner(): NodeJS.Timeout {
  applyBBlockColumns()
  migrateFileBasedTasks()

  let firstTick = true

  const runCheck = () => {
    const catchUpMs = firstTick ? 30 * 60 * 1000 : 60 * 1000
    if (firstTick) firstTick = false
    try {
      runSweepTick(catchUpMs)
    } catch (err) {
      logger.warn({ err }, 'scheduler: unhandled error in sweep tick')
    }
  }

  setTimeout(runCheck, 5000)
  return setInterval(runCheck, 60000)
}
