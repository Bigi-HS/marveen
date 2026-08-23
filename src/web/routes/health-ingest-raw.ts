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

import { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, RequestBodyTooLargeError, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const MAX_RAW_BYTES = 64 * 1024
const N8N_ZEPP_WEBHOOK = 'http://127.0.0.1:5678/webhook/zepp-hc'

export async function tryHandleHealthIngestRaw(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/api/health/ingest-raw') return false
  if (ctx.method !== 'POST') {
    json(ctx.res, { error: 'Method Not Allowed' }, 405)
    return true
  }

  let raw: Buffer
  try {
    raw = await readBody(ctx.req, { maxBytes: MAX_RAW_BYTES })
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      json(ctx.res, { error: 'Payload too large' }, 413)
      return true
    }
    json(ctx.res, { error: 'Failed to read body' }, 400)
    return true
  }

  let n8nRes: Response
  try {
    n8nRes = await fetch(N8N_ZEPP_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw.toString('utf8'),
    })
  } catch {
    json(ctx.res, { error: 'n8n transform unavailable' }, 502)
    return true
  }

  let body: unknown
  try {
    body = await n8nRes.json()
  } catch {
    body = {}
  }

  json(ctx.res, body, n8nRes.status)
  return true
}
