import { appendDailyLog, getDailyLogDates, recallByDateRange } from '../../noa-memory.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleDailyLog(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/daily-log' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id?: string; content: string }
    if (!data.content?.trim()) { json(res, { error: 'Content required' }, 400); return true }
    appendDailyLog(data.agent_id || MAIN_AGENT_ID, data.content.trim())
    json(res, { ok: true })
    return true
  }

  if (path === '/api/daily-log' && method === 'GET') {
    const agent = url.searchParams.get('agent') || MAIN_AGENT_ID
    const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0]
    // noa-memory getDailyLog uses a `since` timestamp; use recallByDateRange for date-scoped
    // lookup to preserve the legacy response shape { id, content, created_at }[].
    const result = recallByDateRange(date, date, agent)
    json(res, result.logs.map(l => ({ id: l.id, content: l.content, created_at: l.created_at })))
    return true
  }

  if (path === '/api/daily-log/dates' && method === 'GET') {
    const agent = url.searchParams.get('agent') || MAIN_AGENT_ID
    json(res, getDailyLogDates(agent))
    return true
  }

  return false
}
