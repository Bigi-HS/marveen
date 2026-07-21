// GET /api/usage/current -- serves the derived Claude usage (card 7fe5662f).
//
// Returns ONLY the credential-free derived shape from the background refresher:
//   200 { fiveHour:{pct,resetAt}, weekly:{pct,resetAt}, stale:bool }
//   503 { reason:'feature-absent' }   -- no store/.claude-session provisioned
//   503 { reason:'auth-expired' }     -- session went stale, manual re-auth needed
//   503 { reason:'unavailable' }      -- endpoint degraded, no cached usage yet
//
// The credential ([G1]/[G3]) never reaches this layer: getUsageState() only ever
// yields the derived UsageState, and getUsageReason() a static reason string.
// Behind the existing global bearer-token auth gate in web.ts -- no extra auth.

import { json } from '../http-helpers.js'
import { getUsageState, getUsageReason } from '../usage-refresher.js'
import type { RouteContext } from './types.js'

export async function tryHandleUsage(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path !== '/api/usage/current' || method !== 'GET') return false

  const state = getUsageState()
  if (state) {
    json(res, state)
    return true
  }

  // No usable cached usage -> feature-absent / auth-expired / unavailable. This
  // is NOT an auth error against the dashboard (the caller passed the bearer
  // gate); it is a feature-state 503 so the panel lazy-renders only on 200.
  const reason = getUsageReason() ?? 'feature-absent'
  json(res, { reason }, 503)
  return true
}
