// POST /api/health/ingest-raw -- raw Health Connect Webhook app payload ingress (WELL-018 Path B).
// The HC Webhook Android app sends its own snake_case array shape. This endpoint
// accepts that raw payload, proxies it to the local n8n transform workflow
// (http://127.0.0.1:5678/webhook/zepp-hc), which maps it to the canonical schema
// and POSTs to /api/health/ingest with X-Ingest-Token.
//
// Why a proxy instead of a second tunnel: we already have one Cloudflare tunnel
// (port 3420). Exposing n8n (port 5678) via the same tunnel avoids a second
// cloudflared process and keeps a single public entry point for the phone.
//
// Auth: none (public endpoint per public-paths.ts). n8n holds the ingest token.
// Size cap: same as /api/health/ingest (64 KB).
//
// Retention (card 0b467f56, P0.5): every incoming raw body is written to a bounded
// buffer so TC-1 / AT-1 Layer-2 tests can use real captured payloads. The retain
// callback is injected for testability; the production default uses defaultRawPushBuffer.

import { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, RequestBodyTooLargeError, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { defaultRawPushBuffer } from '../zepp/raw-push-buffer.js'
import type { RouteContext } from './types.js'

// 512KB (not 64KB) so a post-outage multi-day backlog replay (~100KB) is retained
// rather than 413-rejected; still far below the generic 20MB default. See the
// MAX_INGEST_BYTES rationale in health-ingest.ts.
const MAX_RAW_BYTES = 512 * 1024
const N8N_ZEPP_WEBHOOK = 'http://127.0.0.1:5678/webhook/zepp-hc'

export interface HealthIngestRawDeps {
  /** Called with the raw body string on every push (successful read). Used for retention corpus. */
  retain?: (rawBody: string) => void
}

export function makeHealthIngestRawHandler(deps: HealthIngestRawDeps = {}) {
  return async function handleHealthIngestRaw(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      json(res, { error: 'Method Not Allowed' }, 405)
      return
    }

    let raw: Buffer
    try {
      raw = await readBody(req, { maxBytes: MAX_RAW_BYTES })
    } catch (err) {
      if (err instanceof RequestBodyTooLargeError) {
        json(res, { error: 'Payload too large' }, 413)
        return
      }
      json(res, { error: 'Failed to read body' }, 400)
      return
    }

    const rawBodyStr = raw.toString('utf8')

    // Retain the body BEFORE forwarding to n8n so even a transform failure preserves the payload
    // for diagnostics and the test corpus (card 0b467f56, AC-1).
    deps.retain?.(rawBodyStr)

    let n8nRes: Response
    try {
      n8nRes = await fetch(N8N_ZEPP_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawBodyStr,
      })
    } catch {
      json(res, { error: 'n8n transform unavailable' }, 502)
      return
    }

    // Do NOT reflect n8n's response body to this unauthenticated public caller on failure:
    // the transform's internal error detail (node names, stack, file paths) is a zero-auth
    // info leak. Log the real status server-side; return a generic error. (Chad medium, PR#541
    // follow-up.) A 2xx reply is our own /api/health/ingest response, safe to forward.
    if (!n8nRes.ok) {
      logger.warn({ status: n8nRes.status }, 'health ingest-raw: n8n transform returned non-2xx')
      json(res, { error: 'transform failed' }, n8nRes.status >= 500 ? 502 : 400)
      return
    }

    let body: unknown
    try {
      body = await n8nRes.json()
    } catch {
      body = {}
    }

    json(res, body, n8nRes.status)
  }
}

// tryHandle adapter for the web.ts dispatcher
let _handler: ReturnType<typeof makeHealthIngestRawHandler> | null = null

export async function tryHandleHealthIngestRaw(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/api/health/ingest-raw') return false
  if (!_handler) {
    _handler = makeHealthIngestRawHandler({ retain: (b) => defaultRawPushBuffer.retain(b) })
  }
  await _handler(ctx.req, ctx.res)
  return true
}
