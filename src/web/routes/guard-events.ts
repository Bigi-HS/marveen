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
    const daysRaw = parseInt(url.searchParams.get('days') ?? '14')
    const days = Math.min(Math.max(1, isNaN(daysRaw) ? 14 : daysRaw), 90)
    json(res, getGuardEventSummary(days))
    return true
  }

  // GET /api/guard-events -- raw rows; admin-scoped (operator token only).
  // Returns peer pairs and content hashes -- fingerprintable side channel, hence restricted.
  if (path === '/api/guard-events') {
    if (identity && !hasScope(identity.scopes, ADMIN_SCOPE)) {
      json(res, { error: 'Forbidden: admin scope required' }, 403)
      return true
    }
    const limitRaw = parseInt(url.searchParams.get('limit') ?? '100')
    const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 100 : limitRaw), 1000)
    const sinceRaw = url.searchParams.get('since')
    const since = sinceRaw ? (isNaN(parseInt(sinceRaw)) ? undefined : parseInt(sinceRaw)) : undefined
    json(res, getGuardEvents(limit, since))
    return true
  }

  return false
}
