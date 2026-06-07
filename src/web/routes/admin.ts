import { rotateDashboardToken } from '../dashboard-auth.js'
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

  return false
}
