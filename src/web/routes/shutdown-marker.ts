import { json } from '../http-helpers.js'
import { stampCleanShutdown } from '../shutdown-marker.js'
import type { RouteContext } from './types.js'

// Endpoint for the per-agent clean-shutdown marker (memory-continuity Phase 1, S1).
//  POST /api/shutdown-marker/:agent/stamp  <- SessionEnd hook: stamp a clean end.
//
// S1 exposes ONLY the stamp. The SessionStart read/consume + the replay gate
// land in S2 (GET /replay + POST /consume), so the marker is never read until
// its verdict is used. Gated by the dashboard token in web.ts. The stamp is
// fail-open in the module: a write failure is logged, never thrown.
export async function tryHandleShutdownMarker(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  const stampMatch = path.match(/^\/api\/shutdown-marker\/([^/]+)\/stamp$/)
  if (stampMatch && method === 'POST') {
    stampCleanShutdown(decodeURIComponent(stampMatch[1]), Date.now())
    json(res, { ok: true })
    return true
  }

  return false
}
