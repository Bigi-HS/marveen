/**
 * GET /api/pipeline/reality-check?owner=hibiki -- reality gate for token-free pipelines
 * (OPS-125, 85fb3009).
 *
 * Problem: token-free / deterministic pipelines (e.g. Hibiki's napi-push) deliver
 * content even when the underlying reality (adherence, recent activity) says the
 * plan no longer applies. Without an LLM-in-the-loop, there is no natural reality
 * check. This endpoint provides it.
 *
 * Decision logic (pure, unit-testable):
 *   - adherence: active/total workout days in the last 7 day-buckets
 *   - daysSinceLastHabit: days since the owner last logged a habit=done
 *   - shouldProceed: adherence.active > 0 AND daysSinceLastHabit <= maxStaleDays
 *
 * Response: { owner, shouldProceed, adherence, daysSinceLastHabit, maxStaleDays, reason }
 *
 * The pipeline calls this BEFORE delivering. If shouldProceed=false, skip or warn.
 */
import type Database from 'better-sqlite3'
import { getNoaDb } from '../../noa-db.js'
import { trainingAdherence, nowEpochS, type TodoOwner } from '../../db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const VALID_OWNERS: Set<TodoOwner> = new Set(['claudia', 'hibiki', 'bond'])

/** Default: if no habit logged in 14+ days the plan is stale. */
export const DEFAULT_MAX_STALE_DAYS = 14

export interface RealityCheckResult {
  owner: string
  shouldProceed: boolean
  adherence: { active: number; total: number }
  daysSinceLastHabit: number | null
  maxStaleDays: number
  reason: string
}

export function lastHabitAgoSeconds(owner: TodoOwner, db: Database.Database = getNoaDb()): number | null {
  const row = db.prepare(
    `SELECT MAX(created_at) AS ts FROM todo_items
      WHERE owner = ? AND kind = 'habit' AND status = 'done'`
  ).get(owner) as { ts: number | null } | undefined
  const ts = row?.ts ?? null
  if (ts === null) return null
  return nowEpochS() - ts
}

/**
 * Pure reality-gate decision. No DB access -- all inputs injected.
 */
export function decideRealityGate(opts: {
  owner: string
  adherence: { active: number; total: number }
  daysSinceLastHabit: number | null
  maxStaleDays: number
}): RealityCheckResult {
  const { owner, adherence, daysSinceLastHabit, maxStaleDays } = opts

  if (adherence.active === 0) {
    return {
      owner, shouldProceed: false, adherence, daysSinceLastHabit, maxStaleDays,
      reason: `adherence 0/${adherence.total} -- no habit logged in the last ${adherence.total} days`,
    }
  }
  if (daysSinceLastHabit === null) {
    return {
      owner, shouldProceed: false, adherence, daysSinceLastHabit, maxStaleDays,
      reason: 'no habit ever logged -- cannot verify plan is live',
    }
  }
  if (daysSinceLastHabit > maxStaleDays) {
    return {
      owner, shouldProceed: false, adherence, daysSinceLastHabit, maxStaleDays,
      reason: `last habit ${daysSinceLastHabit}d ago > ${maxStaleDays}d stale threshold`,
    }
  }
  return {
    owner, shouldProceed: true, adherence, daysSinceLastHabit, maxStaleDays,
    reason: `ok: adherence ${adherence.active}/${adherence.total}, last habit ${daysSinceLastHabit}d ago`,
  }
}

export async function tryHandlePipelineRealityGate(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path !== '/api/pipeline/reality-check' || method !== 'GET') return false

  const ownerParam = ctx.url.searchParams.get('owner') ?? 'hibiki'
  if (!VALID_OWNERS.has(ownerParam as TodoOwner)) {
    json(res, { error: `Unknown owner: ${ownerParam}` }, 400)
    return true
  }
  const owner = ownerParam as TodoOwner
  const maxStaleDays = parseInt(ctx.url.searchParams.get('max_stale_days') ?? '', 10) || DEFAULT_MAX_STALE_DAYS

  const adherence = trainingAdherence(owner, 7)
  const agoSec = lastHabitAgoSeconds(owner)
  const daysSinceLastHabit = agoSec !== null ? Math.floor(agoSec / 86400) : null

  const result = decideRealityGate({ owner, adherence, daysSinceLastHabit, maxStaleDays })
  json(res, result)
  return true
}
