// curator_verdicts REST API (card 81a912dc).
//
// POST /api/curator/verdicts  -- submit a new verdikt
// GET  /api/curator/verdicts  -- list with optional filters (?verdict=&agent_id=&applied=)
// POST /api/curator/verdicts/apply -- run the nightly applyer on demand

import { getNoaDb } from '../../noa-memory.js'
import {
  saveCuratorVerdict,
  listCuratorVerdicts,
  applyPendingCuratorVerdicts,
  type InsertCuratorVerdict,
} from '../../curator-verdicts.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const VALID_VERDICTS = new Set(['PENDING', 'APPROVE', 'REJECT', 'HOLD'])

export async function tryHandleCurator(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/curator/verdicts/apply -- run applyer
  if (path === '/api/curator/verdicts/apply' && method === 'POST') {
    try {
      const result = applyPendingCuratorVerdicts(getNoaDb())
      logger.info({ result }, 'curator verdikts applied')
      json(res, { ok: true, ...result })
    } catch (err) {
      logger.error({ err }, 'curator apply failed')
      json(res, { error: 'apply failed' }, 500)
    }
    return true
  }

  // GET /api/curator/verdicts
  if (path === '/api/curator/verdicts' && method === 'GET') {
    const verdict = url.searchParams.get('verdict') ?? undefined
    const agent_id = url.searchParams.get('agent_id') ?? undefined
    const appliedParam = url.searchParams.get('applied')
    const applied = appliedParam === null ? undefined : appliedParam === 'true'

    const rows = listCuratorVerdicts(getNoaDb(), { verdict, agent_id, applied })
    json(res, rows)
    return true
  }

  // POST /api/curator/verdicts
  if (path === '/api/curator/verdicts' && method === 'POST') {
    let body: Record<string, unknown>
    try {
      const raw = await readBody(req)
      body = raw.length ? (JSON.parse(raw.toString()) as Record<string, unknown>) : {}
    } catch {
      json(res, { error: 'invalid JSON' }, 400)
      return true
    }

    const { proposal_id, agent_id, entry_a_id, entry_b_id, jaccard, verdict, curator_notes, approved_at, ttl_days } = body

    if (typeof agent_id !== 'string' || !agent_id) {
      json(res, { error: 'agent_id required' }, 400)
      return true
    }
    if (typeof entry_a_id !== 'number' || typeof entry_b_id !== 'number') {
      json(res, { error: 'entry_a_id and entry_b_id must be numbers' }, 400)
      return true
    }
    if (typeof jaccard !== 'number' || jaccard < 0 || jaccard > 1) {
      json(res, { error: 'jaccard must be a number in [0, 1]' }, 400)
      return true
    }
    if (typeof verdict !== 'string' || !VALID_VERDICTS.has(verdict)) {
      json(res, { error: `verdict must be one of: ${[...VALID_VERDICTS].join(', ')}` }, 400)
      return true
    }

    const input: InsertCuratorVerdict = {
      proposal_id: typeof proposal_id === 'string' ? proposal_id : null,
      agent_id,
      entry_a_id,
      entry_b_id,
      jaccard,
      verdict,
      curator_notes: typeof curator_notes === 'string' ? curator_notes : null,
      approved_at: typeof approved_at === 'number' ? approved_at : null,
      ttl_days: typeof ttl_days === 'number' ? ttl_days : null,
    }

    try {
      const id = saveCuratorVerdict(getNoaDb(), input)
      json(res, { ok: true, id })
    } catch (err) {
      logger.error({ err }, 'curator verdict save failed')
      json(res, { error: 'save failed' }, 500)
    }
    return true
  }

  return false
}
