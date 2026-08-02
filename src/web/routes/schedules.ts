import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  listPendingTaskRetries, deletePendingTaskRetryById,
} from '../../db.js'
import { MAIN_AGENT_ID, BOT_NAME } from '../../config.js'
import { runAgent } from '../../agent.js'
import { logger } from '../../logger.js'
import { toPendingRetryView } from '../../pending-retries.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { isValidCronShape } from '../cron.js'
import { readBody, json, RequestBodyTooLargeError } from '../http-helpers.js'
import { sanitizeScheduleName, safeScheduleName } from '../sanitize.js'
import { listAgentNames, readAgentDisplayName } from '../agent-config.js'
import { readFileOr } from '../agent-config.js'
import {
  SCHEDULED_TASKS_DIR, MAX_SCHEDULED_TASK_PROMPT_LEN,
  listScheduledTasks, writeScheduledTask,
} from '../scheduled-tasks-io.js'
import { buildScheduledTaskPrompt } from '../schedule-runner.js'
import { injectToSession, resolveSession } from '../action-trigger.js'
import {
  syncTaskToNoa, removeTaskFromNoa, updateTask, TaskNotFoundError,
  recordTriggerFire, getTask,
} from '../../noa-scheduler.js'
import type { RouteContext } from './types.js'

// Test seams: injectable so route unit tests can drive injectToSession / recordTriggerFire
// return values without vi.mock-ing the entire dependency modules.
let _inject: typeof injectToSession = injectToSession
export function __setInjector(fn: typeof injectToSession): void { _inject = fn }
export function __resetInjector(): void { _inject = injectToSession }

let _recordFire: typeof recordTriggerFire = recordTriggerFire
export function __setRecordFireFn(fn: typeof recordTriggerFire): void { _recordFire = fn }
export function __resetRecordFireFn(): void { _recordFire = recordTriggerFire }

export async function tryHandleSchedules(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/schedules/agents' && method === 'GET') {
    const agentNames = listAgentNames()
    const agents = [
      { name: MAIN_AGENT_ID, label: BOT_NAME, avatar: '/api/marveen/avatar' },
      ...agentNames.map(n => ({ name: n, label: readAgentDisplayName(n), avatar: `/api/agents/${encodeURIComponent(n)}/avatar` }))
    ]
    json(res, agents)
    return true
  }

  if (path === '/api/schedules/expand-questions' && method === 'POST') {
    const body = await readBody(req)
    const { prompt, agent } = JSON.parse(body.toString()) as { prompt: string; agent?: string }
    if (!prompt?.trim()) { json(res, { error: 'Prompt is required' }, 400); return true }

    const aiPrompt = `A felhasznalo egy utemezett feladatot akar letrehozni egy AI agensnek. A rovid leirasa:
"${prompt.trim()}"
${agent ? `Az agens neve: ${agent}` : ''}

Generalj 3-4 feleletvalasztos kerdest, amivel pontositani lehet a feladatot. Minden kerdeshez adj 2-4 valaszlehetoseget.

Valaszolj KIZAROLAG JSON formatumban, semmi mas:
[
  {"question": "Kerdes szovege?", "options": ["Opcio 1", "Opcio 2", "Opcio 3"]},
  {"question": "Masik kerdes?", "options": ["A", "B"]}
]`

    try {
      const { text } = await runAgent(aiPrompt)
      if (!text) throw new Error('No response')
      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) throw new Error('Invalid response format')
      const questions = JSON.parse(jsonMatch[0])
      json(res, questions)
    } catch (err) {
      logger.error({ err }, 'Failed to generate expand questions')
      json(res, { error: 'Failed to generate questions' }, 500)
    }
    return true
  }

  if (path === '/api/schedules/expand-prompt' && method === 'POST') {
    const body = await readBody(req)
    const { prompt, answers } = JSON.parse(body.toString()) as { prompt: string; answers: { question: string; answer: string }[] }
    if (!prompt?.trim()) { json(res, { error: 'Prompt is required' }, 400); return true }

    const answersText = answers.map((a: { question: string; answer: string }) => `Kerdes: ${a.question}\nValasz: ${a.answer}`).join('\n\n')

    const aiPrompt = `Bovitsd ki ezt a rovid feladat-leirast egy reszletes, egyertelmu promptta amit egy AI asszisztens vegre tud hajtani.
A prompt legyen magyar nyelvu, konkret utasitasokkal.

Rovid leiras: "${prompt.trim()}"

A felhasznalo valaszai a pontosito kerdesekre:
${answersText}

Az eredmeny CSAK a kibovitett prompt szovege legyen, semmi mas. Ne hasznalj code fence-t.`

    try {
      const { text } = await runAgent(aiPrompt)
      if (!text) throw new Error('No response')
      let expanded = text.trim()
      if (expanded.startsWith('```')) expanded = expanded.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
      json(res, { prompt: expanded })
    } catch (err) {
      logger.error({ err }, 'Failed to expand prompt')
      json(res, { error: 'Failed to expand prompt' }, 500)
    }
    return true
  }

  if (path === '/api/schedules' && method === 'GET') {
    json(res, listScheduledTasks())
    return true
  }

  if (path === '/api/schedules' && method === 'POST') {
    let body: Buffer
    try {
      body = await readBody(req, { maxBytes: 256 * 1024 })
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: `Request body too large (max ${err.limit} bytes)` }, 413)
        return true
      }
      throw err
    }
    const data = JSON.parse(body.toString()) as {
      name: string; description: string; prompt: string; schedule: string; agent?: string; type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string
    }
    const name = sanitizeScheduleName(data.name || '')
    if (!name) { json(res, { error: 'Name is required' }, 400); return true }
    if (!data.prompt?.trim()) { json(res, { error: 'Prompt is required' }, 400); return true }
    if (data.prompt.length > MAX_SCHEDULED_TASK_PROMPT_LEN) {
      json(res, {
        error: `Prompt too large (${data.prompt.length} chars, max ${MAX_SCHEDULED_TASK_PROMPT_LEN})`,
      }, 413)
      return true
    }
    if (!data.schedule?.trim()) { json(res, { error: 'Schedule is required' }, 400); return true }
    if (!isValidCronShape(data.schedule)) { json(res, { error: 'Invalid cron expression' }, 400); return true }

    const dir = join(SCHEDULED_TASKS_DIR, name)
    if (existsSync(dir)) { json(res, { error: 'Schedule already exists' }, 409); return true }

    // Dual-write to noa.db BEFORE file write; validation error -> 400, no file created
    try {
      syncTaskToNoa({
        id: name,
        agent: data.agent || MAIN_AGENT_ID,
        type: (data.type || 'task') as 'task' | 'heartbeat',
        prompt: data.prompt.trim(),
        schedule: data.schedule.trim(),
        description: data.description || '',
        status: 'active',
      })
    } catch (err) {
      json(res, { error: (err as Error).message }, 400)
      return true
    }

    writeScheduledTask(name, {
      description: data.description || '',
      prompt: data.prompt.trim(),
      schedule: data.schedule.trim(),
      agent: data.agent || MAIN_AGENT_ID,
      enabled: true,
      type: data.type || 'task',
      skipIfBusy: data.skipIfBusy === true,
      forceSend: data.forceSend === true,
      targetSession: data.targetSession || undefined,
    })
    logger.info({ name, schedule: data.schedule }, 'Scheduled task created')
    json(res, { ok: true, name })
    return true
  }

  const scheduleUpdateMatch = path.match(/^\/api\/schedules\/([^/]+)$/)
  if (scheduleUpdateMatch && method === 'PUT') {
    const name = safeScheduleName(scheduleUpdateMatch[1])
    if (!name) { json(res, { error: 'Schedule not found' }, 404); return true }
    const dir = join(SCHEDULED_TASKS_DIR, name)
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }

    let body: Buffer
    try {
      body = await readBody(req, { maxBytes: 256 * 1024 })
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: `Request body too large (max ${err.limit} bytes)` }, 413)
        return true
      }
      throw err
    }
    const data = JSON.parse(body.toString()) as {
      description?: string; prompt?: string; schedule?: string; agent?: string; enabled?: boolean; type?: string; skipIfBusy?: boolean; forceSend?: boolean; targetSession?: string
    }
    if (data.prompt !== undefined && data.prompt.length > MAX_SCHEDULED_TASK_PROMPT_LEN) {
      json(res, {
        error: `Prompt too large (${data.prompt.length} chars, max ${MAX_SCHEDULED_TASK_PROMPT_LEN})`,
      }, 413)
      return true
    }
    if (data.schedule !== undefined && !isValidCronShape(data.schedule)) {
      json(res, { error: 'Invalid cron expression' }, 400)
      return true
    }
    // Dual-write to noa.db; if task is file-only (not yet in noa.db) self-heal via syncTaskToNoa
    const noaPatch = {
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.prompt !== undefined ? { prompt: data.prompt.trim() } : {}),
      ...(data.schedule !== undefined ? { schedule: data.schedule.trim() } : {}),
      ...(data.agent !== undefined ? { agent: data.agent } : {}),
      ...(data.type !== undefined ? { type: data.type as 'task' | 'heartbeat' } : {}),
      ...(data.enabled !== undefined ? { status: (data.enabled ? 'active' : 'paused') as 'active' | 'paused' } : {}),
    }
    try {
      updateTask(name, noaPatch)
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        // Legacy file-only task: read current file state and self-heal into noa.db
        const fileTask = listScheduledTasks().find(t => t.name === name)
        if (fileTask) {
          syncTaskToNoa({
            id: name,
            agent: (data.agent ?? fileTask.agent) || MAIN_AGENT_ID,
            type: ((data.type ?? fileTask.type) || 'task') as 'task' | 'heartbeat',
            prompt: ((data.prompt ?? fileTask.prompt) || '').trim(),
            schedule: ((data.schedule ?? fileTask.schedule) || '0 9 * * *').trim(),
            description: data.description ?? fileTask.description ?? '',
            status: data.enabled === undefined ? 'active' : (data.enabled ? 'active' : 'paused'),
          })
        }
      } else {
        throw err
      }
    }

    writeScheduledTask(name, data)
    logger.info({ name }, 'Scheduled task updated')
    json(res, { ok: true })
    return true
  }

  if (scheduleUpdateMatch && method === 'DELETE') {
    const name = safeScheduleName(scheduleUpdateMatch[1])
    if (!name) { json(res, { error: 'Schedule not found' }, 404); return true }
    const dir = join(SCHEDULED_TASKS_DIR, name)
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }
    removeTaskFromNoa(name)  // tolerant: no-op if not yet in noa.db
    rmSync(dir, { recursive: true, force: true })
    logger.info({ name }, 'Scheduled task deleted')
    json(res, { ok: true })
    return true
  }

  const scheduleToggleMatch = path.match(/^\/api\/schedules\/([^/]+)\/toggle$/)
  if (scheduleToggleMatch && method === 'POST') {
    const name = safeScheduleName(scheduleToggleMatch[1])
    if (!name) { json(res, { error: 'Schedule not found' }, 404); return true }
    const dir = join(SCHEDULED_TASKS_DIR, name)
    if (!existsSync(dir)) { json(res, { error: 'Schedule not found' }, 404); return true }

    const configPath = join(dir, 'task-config.json')
    let config: Record<string, unknown> = {}
    try { config = JSON.parse(readFileOr(configPath, '{}')) } catch { /* use empty */ }
    const newEnabled = !(config.enabled !== false)

    // Dual-write toggle to noa.db
    try {
      updateTask(name, { status: newEnabled ? 'active' : 'paused' })
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        // Legacy file-only task: self-heal
        const fileTask = listScheduledTasks().find(t => t.name === name)
        if (fileTask) {
          syncTaskToNoa({
            id: name,
            agent: fileTask.agent || MAIN_AGENT_ID,
            type: (fileTask.type || 'task') as 'task' | 'heartbeat',
            prompt: (fileTask.prompt || '').trim(),
            schedule: (fileTask.schedule || '0 9 * * *').trim(),
            description: fileTask.description ?? '',
            status: newEnabled ? 'active' : 'paused',
          })
        }
      } else {
        throw err
      }
    }

    config.enabled = newEnabled
    atomicWriteFileSync(configPath, JSON.stringify(config, null, 2))
    logger.info({ name, enabled: newEnabled }, 'Scheduled task toggled')
    json(res, { ok: true, enabled: newEnabled })
    return true
  }

  // Fire a scheduled task NOW, on operator demand or from an external trigger (n8n).
  //
  // mode: 'manual' (default) -- fires WITHOUT updating last_run/next_run so the
  //   native cron runner still fires at its scheduled time. Use for operator/debug runs.
  //
  // mode: 'trigger' -- fires AND, ONLY on 'fired' success, rolls last_run/next_run
  //   forward using the same formula as the native sweep tick. This makes the native
  //   runner treat the task as "already fired" and skip its next poll -- converting
  //   native into a true fallback.
  //   LOST-INJECT safety: on 'offline' or 'busy', last_run/next_run are NOT advanced so
  //   the native runner can fire as recovery. On 'busy' the prompt was not injected at
  //   all; advancing would suppress the native retry with no actual execution.
  //
  // Narrow same-tick race: if the native poll query runs in the same second as this
  // UPDATE commits, both may fire. The 409-busy response from the second inject is
  // harmless (the agent ignores duplicate prompts while processing). This race window
  // is ~1s and non-blocking by design; no additional coordination is required.
  const scheduleRunMatch = path.match(/^\/api\/schedules\/([^/]+)\/run$/)
  if (scheduleRunMatch && method === 'POST') {
    const name = safeScheduleName(scheduleRunMatch[1])
    if (!name) { json(res, { error: 'Schedule not found' }, 404); return true }
    const fileTask = listScheduledTasks().find(t => t.name === name)
    if (!fileTask) { json(res, { error: 'Schedule not found' }, 404); return true }

    let force = false
    let triggerMode = false
    try {
      const body = await readBody(req, { maxBytes: 4 * 1024 })
      if (body.length) {
        const parsed = JSON.parse(body.toString()) as { force?: boolean; mode?: string }
        force = parsed.force === true
        triggerMode = parsed.mode === 'trigger'
      }
    } catch { /* no/blank body -> defaults */ }

    const agentName = fileTask.agent || MAIN_AGENT_ID
    const session = fileTask.targetSession || resolveSession(agentName)
    const prompt = buildScheduledTaskPrompt(fileTask, agentName)
    const status = _inject(session, prompt, { force })

    if (status === 'offline') {
      json(res, { error: `Target session for "${name}" is not running`, status }, 503)
      return true
    }
    if (status === 'busy') {
      // Prompt was NOT injected; do NOT advance last_run/next_run -- native retries as recovery.
      json(res, { error: `Target session for "${name}" is busy; retry or use force`, status }, 409)
      return true
    }

    if (triggerMode) {
      const dbTask = getTask(name)
      if (dbTask) _recordFire(dbTask)
    }
    logger.info({ name, agent: agentName, session, force, triggerMode }, 'Scheduled task fired on operator demand')
    json(res, { ok: true, status, agent: agentName })
    return true
  }

  if (path === '/api/schedules/pending' && method === 'GET') {
    const now = Date.now()
    const rows = listPendingTaskRetries().map(r => toPendingRetryView(r, now))
    json(res, rows)
    return true
  }

  const pendingCancelMatch = path.match(/^\/api\/schedules\/pending\/(\d+)$/)
  if (pendingCancelMatch && method === 'DELETE') {
    const id = parseInt(pendingCancelMatch[1], 10)
    if (!Number.isFinite(id)) { json(res, { error: 'Invalid id' }, 400); return true }
    const removed = deletePendingTaskRetryById(id)
    if (!removed) { json(res, { error: 'Pending retry not found' }, 404); return true }
    logger.info({ id }, 'Pending scheduled-task retry cancelled via API')
    json(res, { ok: true })
    return true
  }

  return false
}
