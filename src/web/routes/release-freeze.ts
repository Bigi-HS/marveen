// Server-side planning-freeze API (card 2efcb439, slice 4c-3).
//
//   GET  /api/release/planning-freeze            -> { frozen: boolean }
//   POST /api/release/planning-freeze {frozen}   -> { frozen: boolean }
//
// WHY THIS EXISTS (Inv-8): the release pipeline's fix-window job (§6) and the
// deploy gate (§7) must consult an AUTHORITATIVE freeze source before acting.
// The spec's conservative rule is "the authoritative source is the server
// freeze-API; the store/planning-freeze.enabled FILE is only the fallback when
// the server is unreachable (presence = SKIP, absence != automatic green)".
// This route is that authoritative server source. It reads and writes the SAME
// store/planning-freeze.enabled flag through planning-freeze.ts, so there is ONE
// freeze contract across the agent-respawn gate, the deploy gate and this HTTP
// surface -- a remote caller never has to read the flag file directly.
//
// GET is read-only. POST is the operator control to set/clear the freeze; it is
// logged with the resolved caller identity. Both the read and the write are
// injectable (__setReleaseFreezeDeps) so the branches are testable in-process
// without touching the real store/ flag file.

import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { planningFreezeEnabled, setPlanningFreezeEnabled } from '../planning-freeze.js'
import type { RouteContext } from './types.js'

let freezeReader: () => boolean = planningFreezeEnabled
let freezeWriter: (enabled: boolean) => void = setPlanningFreezeEnabled
export function __setReleaseFreezeDeps(deps: {
  read?: () => boolean
  write?: (enabled: boolean) => void
}): void {
  if (deps.read !== undefined) freezeReader = deps.read
  if (deps.write !== undefined) freezeWriter = deps.write
}
export function __resetReleaseFreezeDeps(): void {
  freezeReader = planningFreezeEnabled
  freezeWriter = setPlanningFreezeEnabled
}

export async function tryHandleReleaseFreeze(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, identity } = ctx
  if (path !== '/api/release/planning-freeze') return false

  // -------------------------------------------------------------------------
  // GET -- authoritative freeze state read
  // -------------------------------------------------------------------------
  if (method === 'GET') {
    let frozen: boolean
    try {
      frozen = freezeReader()
    } catch (err) {
      // Never report a silent "not frozen" on a read failure: an unreadable
      // state must surface so the caller stays conservative, not assume green.
      logger.warn({ caller: identity.agentId, err }, 'release freeze: state read failed')
      json(res, { error: 'could not read freeze state' }, 500)
      return true
    }
    json(res, { frozen }, 200)
    return true
  }

  // -------------------------------------------------------------------------
  // POST -- operator set/clear
  // -------------------------------------------------------------------------
  if (method === 'POST') {
    let parsed: Record<string, unknown>
    try {
      const raw = (await readBody(req, { maxBytes: 1024 })).toString('utf-8')
      parsed = raw ? JSON.parse(raw) : {}
    } catch {
      json(res, { error: 'invalid request body' }, 400)
      return true
    }

    if (typeof parsed['frozen'] !== 'boolean') {
      json(res, { error: 'frozen (boolean) is required' }, 400)
      return true
    }
    const frozen = parsed['frozen']

    try {
      freezeWriter(frozen)
    } catch (err) {
      logger.warn({ caller: identity.agentId, frozen, err }, 'release freeze: state write failed')
      json(res, { error: 'could not set freeze state' }, 500)
      return true
    }

    logger.info(
      { caller: identity.agentId, frozen },
      `release freeze: planning-freeze ${frozen ? 'ENABLED' : 'cleared'}`,
    )
    json(res, { frozen }, 200)
    return true
  }

  json(res, { error: 'method not allowed' }, 405)
  return true
}
