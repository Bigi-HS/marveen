// ACK-capability V2 declare endpoint (card 83b7ec10).
//
// POST /api/agents/:id/ack-declare  { "ttl_seconds"?: number }
// Upserts the caller agent's runtime capability into agent_ack_registry. Called
// by each ACK-capable agent's SessionStart hook (scripts/hooks/ack-declare.sh),
// so a restart on EITHER launch path (dashboard startAgentProcess OR
// agent-watchdog.sh tmux new-session) self-maintains the registry.
//
// Own route module (mirrors routes/gate.ts) rather than buried in the large
// agents.ts handler, so the endpoint is unit-testable in isolation.

import { isKnownAgent } from '../agent-config.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { getDb } from '../../db.js'
import { declareAck } from '../ack-registry.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleAck(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  const m = path.match(/^\/api\/agents\/([^/]+)\/ack-declare$/)
  if (!m) return false
  if (method !== 'POST') return false // only POST is defined; let other methods 404

  const name = decodeURIComponent(m[1])

  // MAIN_AGENT_ID is capability-true by hardcode (AV2-AC9) and never needs a
  // registry row -- reject so a stray declare cannot create a meaningless entry.
  if (name === MAIN_AGENT_ID) {
    json(res, { error: 'main agent is ack-capable by hardcode, not via the registry' }, 400)
    return true
  }
  // AV2-AC6: unknown agent -> 400, no row written.
  if (!isKnownAgent(name)) {
    json(res, { error: 'unknown agent' }, 400)
    return true
  }

  // ttl_seconds is optional; an empty body declares with the 24h default.
  const raw = (await readBody(req)).toString().trim()
  let ttlSeconds: unknown
  if (raw) {
    try {
      ttlSeconds = (JSON.parse(raw) as { ttl_seconds?: unknown }).ttl_seconds
    } catch {
      json(res, { error: 'invalid JSON' }, 400)
      return true
    }
  }

  // Server-stamped declared_at (caller-supplied timestamps are never trusted).
  const now = Math.floor(Date.now() / 1000)
  const decl = declareAck(getDb(), name, ttlSeconds, now)
  json(res, decl)
  return true
}
