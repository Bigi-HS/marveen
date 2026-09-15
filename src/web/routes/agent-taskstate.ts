import { readBody, json } from '../http-helpers.js'
import {
  readTaskState,
  writeTaskState,
  markConsumed,
  clearTaskState,
  shouldReplayTaskState,
  buildTaskStateInjection,
} from '../agent-taskstate.js'
import { classifyAndConsume } from '../shutdown-marker.js'
import { sessionEndMarkerHookEnabled } from '../agent-scaffold.js'
import type { RouteContext } from './types.js'

// Endpoints for the compact task-state re-injection feature (#4).
//  POST   /api/agent-taskstate/:agent          <- PreCompact agent-hook writes the record
//  GET    /api/agent-taskstate/:agent/replay   <- SessionStart hook: returns inject text (does NOT consume)
//  POST   /api/agent-taskstate/:agent/consume  <- SessionStart hook: mark consumed AFTER a successful inject
//  DELETE /api/agent-taskstate/:agent          <- explicit task-done clear
//
// All gated by the dashboard token in web.ts. The read->inject->consume split
// is deliberate (Marveen): if the hook reads but dies before printing, the
// record stays consumed=false so the next start still catches it.

export async function tryHandleAgentTaskState(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  const replayMatch = path.match(/^\/api\/agent-taskstate\/([^/]+)\/replay$/)
  if (replayMatch && method === 'GET') {
    const agent = decodeURIComponent(replayMatch[1])
    const source = url.searchParams.get('source') || ''
    const record = readTaskState(agent)
    // S2 crash-gate, FLAG-GATED ON BOTH SIDES (mirrors the S1 stamp-side gate).
    // The read path activates ONLY when store/session-end-marker.enabled exists.
    // WHY (NoA c12-finding, merge-gating): the flag gates the STAMP side (hook
    // injection in agent-scaffold). If the read path were flag-independent, then a
    // deploy while the flag is OFF (0 agents stamping) would make every normal
    // 'startup' see an ABSENT marker => classifyLastBoot='crash' => a clean restart
    // false-resumes. Gating BOTH sides on the SAME flag keeps "deploy is always
    // safe, activation is one operator-touch" true: flag OFF => 'unknown' => a cold
    // 'startup' never resumes (today's behavior) AND the marker is not consumed, so
    // S1+S2 activate atomically on the single flag-touch. flag ON + 'startup' =>
    // classify + consume (consume-once). compact|resume replay via REPLAY_SOURCES
    // regardless and must never touch the marker.
    const lastBoot = (sessionEndMarkerHookEnabled() && source === 'startup')
      ? classifyAndConsume(agent, Date.now())
      : 'unknown'
    const inject = shouldReplayTaskState(record, source, lastBoot, Date.now())
      ? buildTaskStateInjection(record!)
      : null
    json(res, { additionalContext: inject })
    return true
  }

  const consumeMatch = path.match(/^\/api\/agent-taskstate\/([^/]+)\/consume$/)
  if (consumeMatch && method === 'POST') {
    markConsumed(decodeURIComponent(consumeMatch[1]))
    json(res, { ok: true })
    return true
  }

  const baseMatch = path.match(/^\/api\/agent-taskstate\/([^/]+)$/)
  if (baseMatch && method === 'POST') {
    const agent = decodeURIComponent(baseMatch[1])
    const body = await readBody(req)
    let fields: Record<string, unknown>
    try { fields = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const record = writeTaskState(agent, {
      doneSteps: fields.doneSteps as string[] | undefined,
      alreadyDelegated: fields.alreadyDelegated as string[] | undefined,
      nextAction: fields.nextAction as string | undefined,
      pendingDecision: fields.pendingDecision as string | undefined,
      summary: fields.summary as string | undefined,
    }, Date.now())
    json(res, { ok: true, record })
    return true
  }

  if (baseMatch && method === 'GET') {
    json(res, readTaskState(decodeURIComponent(baseMatch[1])))
    return true
  }

  if (baseMatch && method === 'DELETE') {
    clearTaskState(decodeURIComponent(baseMatch[1]))
    json(res, { ok: true })
    return true
  }

  return false
}
