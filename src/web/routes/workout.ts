// Workout relay endpoints (Phase 0D, card f22c8803)
//
// GET  /api/workout/plan     -- Hibiki memory relay (today's workout plan)
// POST /api/workout/checkin  -- relay check-in note to Hibiki via inter-agent
//
// Auth: any authenticated identity required.

import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { getNoaDb } from '../../noa-db.js'
import type { RouteContext } from './types.js'
import type { WorkoutPlan } from '../../types/app.js'

// ---------------------------------------------------------------------------
// Plan fetcher seam (reads Hibiki memory in production)
// ---------------------------------------------------------------------------

type PlanFetcher = () => Promise<WorkoutPlan | null>

let _planFetcher: PlanFetcher | null = null
export function __setPlanFetcher(fn: PlanFetcher | null): void { _planFetcher = fn }

function defaultPlanFetcher(): PlanFetcher {
  return async () => {
    const db = getNoaDb()
    const rows = db.prepare(
      `SELECT content FROM memories
       WHERE agent_id = 'hibiki'
         AND (keywords LIKE '%workout%' OR keywords LIKE '%edzes%' OR keywords LIKE '%terv%')
       ORDER BY created_at DESC LIMIT 1`,
    ).all() as Array<{ content: string }>
    if (!rows.length) return null
    // Best-effort parse: return raw content as notes if not structured JSON
    try {
      return JSON.parse(rows[0].content) as WorkoutPlan
    } catch {
      return { date: new Date().toISOString().slice(0, 10), exercises: [], notes: rows[0].content }
    }
  }
}

function getPlanFetcher(): PlanFetcher {
  return _planFetcher ?? defaultPlanFetcher()
}

// ---------------------------------------------------------------------------
// Checkin sender seam (sends inter-agent to Hibiki in production)
// ---------------------------------------------------------------------------

type CheckinSender = (note: string, completed: boolean) => Promise<void>

let _checkinSender: CheckinSender | null = null
export function __setCheckinSender(fn: CheckinSender | null): void { _checkinSender = fn }

function defaultCheckinSender(): CheckinSender {
  return async (note, completed) => {
    const db = getNoaDb()
    db.prepare(
      `INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, priority)
       VALUES ('marveen', 'hibiki', ?, 'pending', unixepoch(), 50)`,
    ).run(`[App workout checkin] completed=${completed} note: ${note}`)
  }
}

function getCheckinSender(): CheckinSender {
  return _checkinSender ?? defaultCheckinSender()
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function tryHandleWorkout(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, identity } = ctx

  if (!path.startsWith('/api/workout/')) return false

  if (!identity?.agentId) {
    json(res, { error: 'authentication required' }, 403)
    return true
  }

  if (path === '/api/workout/plan' && method === 'GET') {
    try {
      const plan = await getPlanFetcher()()
      json(res, { plan })
    } catch (err) {
      logger.error({ err }, 'workout/plan: fetch error')
      json(res, { error: 'could not fetch workout plan' }, 503)
    }
    return true
  }

  if (path === '/api/workout/checkin' && method === 'POST') {
    const raw = await readBody(req, { maxBytes: 8 * 1024 })
    let parsed: { note?: unknown; completed?: unknown }
    try {
      parsed = JSON.parse(raw.toString())
    } catch {
      json(res, { error: 'invalid JSON' }, 400)
      return true
    }
    if (!parsed.note && parsed.completed === undefined) {
      json(res, { error: 'note or completed is required' }, 400)
      return true
    }
    const note = typeof parsed.note === 'string' ? parsed.note.slice(0, 1024) : ''
    const completed = parsed.completed === true
    try {
      await getCheckinSender()(note, completed)
      json(res, { ok: true })
    } catch (err) {
      logger.error({ err }, 'workout/checkin: send error')
      json(res, { error: 'could not send checkin' }, 500)
    }
    return true
  }

  return false
}
