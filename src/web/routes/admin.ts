import { rotateDashboardToken, rotateSessionSecret } from '../dashboard-auth.js'
import { logger } from '../../logger.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Admin endpoints for operating the dashboard at runtime. Every route here is
// reached only AFTER the global /api/* bearer-token auth gate in web.ts has
// already validated the request, so these are implicitly protected by the
// current dashboard token -- no extra auth check is needed in this module.
export async function tryHandleAdmin(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  // Rotate the dashboard bearer token without a server restart. Generates a
  // fresh token, persists it to store/.dashboard-token (atomic, 0600) and swaps
  // the in-memory value the auth middleware checks, so the new token is valid
  // immediately and the old one stops working on the very next request.
  // SECURITY: returning the token in the body is intentional -- the caller just
  // proved possession of the current root-equivalent token, and the new token
  // has to reach the operator somehow. It is never logged.
  if (path === '/api/admin/rotate-token' && method === 'POST') {
    const fresh = rotateDashboardToken()
    logger.warn('Dashboard token rotated via admin API')
    json(res, { ok: true, token: fresh })
    return true
  }

  // Log EVERY active session out in one call. Rotates the server-side session
  // signing secret, which immediately fails the signature check on every cookie
  // that was issued under the old secret -- the clean, one-click equivalent of
  // the old manual "rm store/.dashboard-session-secret + restart" recovery.
  // Sessions now have a 1-year TTL (PR #114), so this is the only fast way to
  // mass-revoke (e.g. a leaked-cookie incident). The operator who calls this
  // (themselves authenticated by the current bearer token) keeps API access; only
  // browser SESSION cookies are invalidated, so the next UI request re-prompts
  // for the token. No token is returned -- nothing secret to surface.
  if (path === '/api/admin/logout-all' && method === 'POST') {
    rotateSessionSecret()
    logger.warn('All dashboard sessions revoked via admin API (session secret rotated)')
    json(res, { ok: true })
    return true
  }

  return false
}
