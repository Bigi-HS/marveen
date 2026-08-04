// GET /api/guard-events/summary  -- aggregate view (any authed token)
// GET /api/guard-events          -- raw rows (operator/admin scope only)
//
// SEC-030 / card 90c8c74b

import { getGuardEvents, getGuardEventSummary } from '../../db.js'
import { hasScope, ADMIN_SCOPE } from '../agent-token-registry.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleGuardEvents(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url, identity } = ctx

  if (!path.startsWith('/api/guard-events')) return false
  if (method !== 'GET') { json(res, { error: 'Method not allowed' }, 405); return true }

  // GET /api/guard-events/summary -- aggregate counts, no raw content, open to any authed token
  if (path === '/api/guard-events/summary') {
    const days = Math.min(Math.max(1, parseInt(url.searchParams.get('days') ?? '14')), 90)
    json(res, getGuardEventSummary(days))
    return true
  }

  // GET /api/guard-events -- raw rows; admin-scoped (operator token only)
  if (path === '/api/guard-events') {
    if (identity && !hasScope(identity.scopes, ADMIN_SCOPE)) {
      json(res, { error: 'Forbidden: admin scope required' }, 403)
      return true
    }
    const limit = Math.min(Math.max(1, parseInt(url.searchParams.get('limit') ?? '100')), 1000)
    const sinceParam = url.searchParams.get('since')
    const since = sinceParam ? parseInt(sinceParam) : undefined
    json(res, getGuardEvents(limit, since))
    return true
  }

  return false
}
