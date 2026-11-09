// POST /api/telemetry  -- ingest tool-call / cost / lifecycle events (P0 bus)
// GET  /api/telemetry/edges -- aggregated actor→object edge weights (P5 graph)
//
// Security:
//   - Loopback-only for POST (hook runs locally, same host as server).
//   - Bearer-auth for GET (dashboard panels + tests).
//   - PII-guard on meta: allowlist keys + 256-char value cap (§5b, telemetry.ts).
//
// Fire-and-forget posture: POST always returns 2xx; a failed emit MUST NOT break
// the calling tool (a hook failure blocks the agent). Errors are logged server-side.

import { getDb } from '../../db.js'
import { logger } from '../../logger.js'
import { json, readBody } from '../http-helpers.js'
import {
  insertTelemetryEvent,
  insertTelemetryBatch,
  queryTelemetryEdges,
  queryTelemetrySeries,
  type TelemetryEventInput,
} from '../telemetry.js'
import type { RouteContext } from './types.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'])

function isLoopback(ctx: RouteContext): boolean {
  const ra = (ctx.req.socket as { remoteAddress?: string })?.remoteAddress ?? ''
  return LOOPBACK.has(ra)
}

function isValidEvent(e: unknown): e is TelemetryEventInput {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false
  const ev = e as Record<string, unknown>
  return typeof ev['actor'] === 'string' && ev['actor'].length > 0
      && typeof ev['verb'] === 'string' && ev['verb'].length > 0
}

export async function tryHandleTelemetry(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/telemetry -- ingest a single event or a batch array.
  // Loopback-only: hooks run locally.
  if (path === '/api/telemetry' && method === 'POST') {
    if (!isLoopback(ctx)) {
      json(res, { error: 'loopback only' }, 403)
      return true
    }

    let body: unknown
    try {
      const raw = await readBody(req)
      body = JSON.parse(raw.toString())
    } catch {
      json(res, { error: 'invalid JSON' }, 400)
      return true
    }

    const db = getDb()
    try {
      if (Array.isArray(body)) {
        const valid = body.filter(isValidEvent)
        const inserted = insertTelemetryBatch(db, valid)
        json(res, { ok: true, inserted }, 201)
      } else if (isValidEvent(body)) {
        const id = insertTelemetryEvent(db, body)
        json(res, { ok: true, id }, 201)
      } else {
        json(res, { error: 'actor and verb are required' }, 400)
      }
    } catch (err) {
      // Fire-and-forget: log but do not propagate (hook must never block agent).
      logger.warn({ err }, '[telemetry] insert failed')
      json(res, { ok: false, error: 'insert failed' }, 500)
    }
    return true
  }

  // GET /api/telemetry/edges -- aggregated actor→object edges for the P5 graph.
  if (path === '/api/telemetry/edges' && method === 'GET') {
    const fromTs = url.searchParams.get('from')
      ? parseInt(url.searchParams.get('from')!, 10) : undefined
    const toTs = url.searchParams.get('to')
      ? parseInt(url.searchParams.get('to')!, 10) : undefined
    const actor = url.searchParams.get('actor') ?? undefined
    const limit = url.searchParams.get('limit')
      ? parseInt(url.searchParams.get('limit')!, 10) : undefined

    const edges = queryTelemetryEdges(getDb(), { fromTs, toTs, actor, limit })
    json(res, { edges, count: edges.length })
    return true
  }

  // GET /api/telemetry/series -- daily trend from telemetry_daily (cost / tokens / session-wake).
  // Query params: metric=cost|tokens|session-wake  from=YYYY-MM-DD  to=YYYY-MM-DD  actor=  limit=
  if (path === '/api/telemetry/series' && method === 'GET') {
    const metric = url.searchParams.get('metric') ?? undefined
    const fromDay = url.searchParams.get('from') ?? undefined
    const toDay = url.searchParams.get('to') ?? undefined
    const actor = url.searchParams.get('actor') ?? undefined
    const limit = url.searchParams.get('limit')
      ? parseInt(url.searchParams.get('limit')!, 10) : undefined

    const series = queryTelemetrySeries(getDb(), { metric, fromDay, toDay, actor, limit })
    json(res, { series, metric: metric ?? 'all', count: series.length })
    return true
  }

  return false
}
