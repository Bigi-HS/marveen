import {
  collectTokenUsage,
  getTokenSummary,
  getTokenTimeline,
  getTokenDetails,
  getCostBySession,
  getLineageRollup,
  correlateWithKanban,
  getTokenUsageLiveness,
  getFableBudget,
  getFableBudgetStatus,
} from '../token-usage.js'
import { json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

export async function tryHandleTokenUsage(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/token-usage/collect' && method === 'POST') {
    try {
      // ?reparse=1 forces a clean re-ingest (cursor reset) so legacy rows pick up
      // the new model / spawned_by attribution columns (card bb4992dc backfill).
      const reparse = url.searchParams.get('reparse') === '1'
      const result = await collectTokenUsage({ reparse })
      correlateWithKanban()
      json(res, { ok: true, ...result })
    } catch (err) {
      logger.error({ err }, 'Token usage collection failed')
      json(res, { error: 'Collection failed' }, 500)
    }
    return true
  }

  // Cache-aware cost rollup: per-agent USD + the parent->child lineage rollup
  // (phantom children's cost, separable from the parent's own sessions).
  if (path === '/api/token-usage/cost' && method === 'GET') {
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const fromN = from ? parseInt(from) : undefined
    const toN = to ? parseInt(to) : undefined
    json(res, {
      agents: getTokenSummary(fromN, toN),
      lineage: getLineageRollup(fromN, toN),
    })
    return true
  }

  if (path === '/api/token-usage/sessions' && method === 'GET') {
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    json(res, getCostBySession({
      agent: url.searchParams.get('agent') || undefined,
      from: from ? parseInt(from) : undefined,
      to: to ? parseInt(to) : undefined,
    }))
    return true
  }

  if (path === '/api/token-usage/summary' && method === 'GET') {
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const summary = getTokenSummary(
      from ? parseInt(from) : undefined,
      to ? parseInt(to) : undefined,
    )
    json(res, summary)
    return true
  }

  // Fable safety-net F1 slice-2: is the token_usage stream fresh? Fail-safe --
  // an empty/stalled table reports stale=true so guards never read blindness as
  // "no spend". Optional ?stale_ms= overrides the 20-min default for ops.
  if (path === '/api/token-usage/liveness' && method === 'GET') {
    const staleMsRaw = url.searchParams.get('stale_ms')
    const parsed = staleMsRaw !== null ? parseInt(staleMsRaw, 10) : NaN
    const staleThresholdMs = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    json(res, getTokenUsageLiveness({ staleThresholdMs }))
    return true
  }

  // Fable safety-net F1 slice-3: fable-only spend over 5h / today / week windows,
  // with a fail-safe blind flag. Direct DB window-query (no detail-endpoint
  // truncation). The daily figure is what the slice-4 ceiling checks against.
  if (path === '/api/token-usage/fable-budget' && method === 'GET') {
    json(res, getFableBudget())
    return true
  }

  // Fable safety-net F1 slice-4: one-boolean restrict signal for a watchdog to
  // poll (F2 auto-revert). 503 when restrict=true (today over the ceiling, or
  // blind telemetry), else 200. ?ceiling= overrides the daily token ceiling for
  // ops/testing; absent -> the FABLE_DAILY_TOKEN_CEILING config default (0 =
  // dormant cap, only blind restricts).
  if (path === '/api/token-usage/fable-budget/status' && method === 'GET') {
    const ceilRaw = url.searchParams.get('ceiling')
    const parsed = ceilRaw !== null ? parseInt(ceilRaw, 10) : NaN
    const dailyTokenCeiling = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    const status = getFableBudgetStatus({ dailyTokenCeiling })
    json(res, status, status.restrict ? 503 : 200)
    return true
  }

  if (path === '/api/token-usage/timeline' && method === 'GET') {
    const bucketMinutes = parseInt(url.searchParams.get('bucket') || '60')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const agent = url.searchParams.get('agent') || undefined
    const timeline = getTokenTimeline(
      bucketMinutes,
      from ? parseInt(from) : undefined,
      to ? parseInt(to) : undefined,
      agent,
    )
    json(res, timeline)
    return true
  }

  if (path === '/api/token-usage' && method === 'GET') {
    const agent = url.searchParams.get('agent') || undefined
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const limit = parseInt(url.searchParams.get('limit') || '100')
    const offset = parseInt(url.searchParams.get('offset') || '0')
    const minTokens = url.searchParams.get('min_tokens')
    const q = url.searchParams.get('q') || undefined
    const details = getTokenDetails({
      agent,
      from: from ? parseInt(from) : undefined,
      to: to ? parseInt(to) : undefined,
      limit: Math.min(limit, 500),
      offset,
      minTokens: minTokens ? parseInt(minTokens) : undefined,
      q,
    })
    json(res, details)
    return true
  }

  return false
}
