import { readBody, json } from '../http-helpers.js'
import {
  writeCheckpoint,
  resolveCheckpoint,
  markCheckpointConsumed,
  clearCheckpoint,
  shouldReplayCheckpoint,
  buildCheckpointInjection,
  injectionHasLastTurns,
  stampLedgerSuppressed,
} from '../agent-checkpoint.js'
import { classifyAndConsume } from '../shutdown-marker.js'
import { sessionEndMarkerHookEnabled } from '../agent-scaffold.js'
import type { RouteContext } from './types.js'

// Endpoints for the memory-continuity S3 checkpoint (superset of task-state).
//  POST   /api/agent-checkpoint/:agent          <- PreCompact/SessionEnd/tick hook writes the record
//  GET    /api/agent-checkpoint/:agent/replay   <- SessionStart hook: returns inject text (does NOT consume)
//  POST   /api/agent-checkpoint/:agent/consume  <- SessionStart hook: mark consumed AFTER a successful inject
//  DELETE /api/agent-checkpoint/:agent          <- explicit clear
//
// The read->inject->consume split mirrors the S2 task-state route: if the hook
// reads but dies before printing, the record stays consumed=false so the next
// start still catches it. All gated by the dashboard token in web.ts.
//
// DEDUP / COMBINED-BUDGET (the S3 contract):
//  - /replay is FLAG-GATED ON BOTH SIDES on session-end-marker.enabled, exactly
//    like the S2 task-state route: flag OFF => 'unknown' => a cold startup never
//    resumes AND the marker is not consumed (S1+S2+S3 co-activate atomically on
//    the single operator flag-touch).
//  - The checkpoint is the SUPERSET: when it replays it stands in for bare
//    task-state (the hook wiring order puts checkpoint-replay first; task-state
//    is the fallback only when no checkpoint exists -- see the taskstate route,
//    unchanged).
//  - When the checkpoint injection carries a recent-turns window it STAMPS the
//    one-boot ledger-suppression marker so the ledger-replay hook skips its own
//    (overlapping) window for THIS boot -> the recent-turns window is injected
//    ONCE, never stacked. The checkpoint lastTurns block is itself char-capped
//    (~4k) so the COMBINED SessionStart continuity budget stays within ~5-6k.

// The flag check is injectable (defaulting to the real helper) purely to give
// tests an ISOLATED gate: the flag lives in ONE global file (store/
// session-end-marker.enabled) that vitest's parallel workers would otherwise
// race on across the S2 and S3 route-test files. Production always uses the
// default. Mirrors the module's existing `db` DI seam.
export interface CheckpointRouteDeps {
  flagEnabled: () => boolean
}
const DEFAULT_DEPS: CheckpointRouteDeps = { flagEnabled: () => sessionEndMarkerHookEnabled() }

export async function tryHandleAgentCheckpoint(
  ctx: RouteContext,
  deps: CheckpointRouteDeps = DEFAULT_DEPS,
): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  const replayMatch = path.match(/^\/api\/agent-checkpoint\/([^/]+)\/replay$/)
  if (replayMatch && method === 'GET') {
    const agent = decodeURIComponent(replayMatch[1])
    const source = url.searchParams.get('source') || ''
    // S2 crash-gate, FLAG-GATED ON BOTH SIDES (mirrors the task-state route). The
    // marker is classified+consumed ONLY when the flag is on and it is a cold
    // startup; compact|resume replay via REPLAY_SOURCES and never touch the marker.
    const lastBoot = (deps.flagEnabled() && source === 'startup')
      ? classifyAndConsume(agent, Date.now())
      : 'unknown'
    // FS primary, else the freshest unconsumed DB row (G2 crash backstop).
    const record = resolveCheckpoint(agent, Date.now())
    let inject: string | null = null
    if (shouldReplayCheckpoint(record, source, lastBoot, Date.now())) {
      inject = buildCheckpointInjection(record!)
      // DEDUP: if this injection supplies the recent-turns window, suppress the
      // overlapping ledger window for THIS boot. Stamp BEFORE returning so the
      // ledger-replay hook (which runs on the same SessionStart) sees it.
      if (injectionHasLastTurns(record!)) stampLedgerSuppressed(agent, Date.now())
    }
    json(res, { additionalContext: inject })
    return true
  }

  const consumeMatch = path.match(/^\/api\/agent-checkpoint\/([^/]+)\/consume$/)
  if (consumeMatch && method === 'POST') {
    markCheckpointConsumed(decodeURIComponent(consumeMatch[1]))
    json(res, { ok: true })
    return true
  }

  const baseMatch = path.match(/^\/api\/agent-checkpoint\/([^/]+)$/)
  if (baseMatch && method === 'POST') {
    const agent = decodeURIComponent(baseMatch[1])
    const body = await readBody(req)
    let fields: Record<string, unknown>
    try { fields = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const record = writeCheckpoint(agent, {
      focus: fields.focus as string | undefined,
      lastTurns: fields.lastTurns as never,
      pendingObservations: fields.pendingObservations as string[] | undefined,
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
    json(res, resolveCheckpoint(decodeURIComponent(baseMatch[1]), Date.now()))
    return true
  }

  if (baseMatch && method === 'DELETE') {
    clearCheckpoint(decodeURIComponent(baseMatch[1]))
    json(res, { ok: true })
    return true
  }

  return false
}
