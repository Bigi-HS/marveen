// GET /api/health/zepp/anomalies -- open cross-field anomaly flags (WELL-028 G3, card 44783957 P0).
// Surfaces the persisted suspect signals (e.g. steps large but distance ~0) so a monitor or
// dashboard can see a plausibility regression instead of it sitting in a silent log line.
// Returns OPEN (unresolved) flags by default; ?all=1 includes resolved flags for audit.
// Auth: dashboard bearer (not public; called via loopback, like the freshness endpoint).

import { json } from '../http-helpers.js'
import { defaultZeppAnomalyStore, type AnomalyFlag, ZeppAnomalyStore } from '../zepp/anomaly-store.js'
import type { RouteContext } from './types.js'

export interface ZeppAnomaliesResult {
  anomalies: AnomalyFlag[]
  openCount: number
  checkedAt: string
}

export function computeAnomalies(store: ZeppAnomalyStore, includeResolved: boolean): ZeppAnomaliesResult {
  const anomalies = includeResolved ? store.list() : store.listOpen()
  return {
    anomalies,
    openCount: store.listOpen().length,
    checkedAt: new Date().toISOString(),
  }
}

let _store: ZeppAnomalyStore | null = null

export async function tryHandleZeppAnomalies(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/api/health/zepp/anomalies' || ctx.method !== 'GET') return false
  if (!_store) _store = defaultZeppAnomalyStore
  const includeResolved = ctx.url.searchParams.get('all') === '1'
  json(ctx.res, computeAnomalies(_store, includeResolved))
  return true
}
