// Telegram loopback relay -- POST /api/notify/telegram
//
// n8n workflows POST here (Bearer dashboard-token, loopback) instead of
// hitting the Telegram Bot API directly. The bot token never enters n8n's
// credential store; only the dashboard token does (Chad boundary, card cd2bd7b9).
//
// Request body: { chat_id: string, text: string, parse_mode?: string, reply_to?: number }
// Response:     { ok: true, message_id: number } | { error: string }

import { logger } from '../../logger.js'
import { readEnvValue } from '../../env.js'
import { readBody, json } from '../http-helpers.js'
import { getCard } from '../../noa-kanban.js'
import { sanitizeCardIds, type CardCodeResolver } from './notify-sanitize.js'
import type { RouteContext } from './types.js'

function readBotToken(): string | null {
  return readEnvValue('TELEGRAM_BOT_TOKEN')
}

// Test seam (mirrors gate.ts __setGatePrFetcher): lets a test override the .env
// bot-token read so the token-missing branch is deterministic without touching
// the real .env. Production always resolves via readBotToken.
let botTokenReader: () => string | null = readBotToken
export function __setBotTokenReader(fn: (() => string | null) | null): void {
  botTokenReader = fn ?? readBotToken
}

// Card 930bba69 AC-P1-1: resolve a candidate 8-hex token to its card (code may be
// null). Default binds the live kanban lookup; a test seam keeps the route hermetic
// so an integration test can assert the outgoing payload without real DB rows.
const defaultCardResolver: CardCodeResolver = (id) => {
  const card = getCard(id)
  return card ? { code: card.code } : null
}
let cardResolver: CardCodeResolver = defaultCardResolver
export function __setCardResolver(fn: CardCodeResolver | null): void {
  cardResolver = fn ?? defaultCardResolver
}

export async function tryHandleNotify(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path !== '/api/notify/telegram' || method !== 'POST') return false

  const body = await readBody(req)
  let parsed: { chat_id?: string | number; text?: string; parse_mode?: string; reply_to?: number }
  try {
    parsed = JSON.parse(body.toString())
  } catch {
    json(res, { error: 'invalid JSON' }, 400)
    return true
  }

  const { chat_id, text, parse_mode, reply_to } = parsed
  // Telegram chat_ids are numeric, so callers (NoA relay / claudia) legitimately
  // serialize chat_id as a JSON number. Coerce before trimming -- a bare
  // `chat_id.trim()` on a number threw and 500'd the whole fallback (card fa3f5012).
  const chatId = chat_id == null ? '' : String(chat_id).trim()
  if (!chatId || !text?.trim()) {
    json(res, { error: 'chat_id and text are required' }, 400)
    return true
  }

  const token = botTokenReader()
  if (!token) {
    logger.error('notify/telegram: TELEGRAM_BOT_TOKEN missing from .env')
    json(res, { error: 'bot token not configured' }, 500)
    return true
  }

  // Card 930bba69 AC-P1-1: rewrite any known card-id to its code before the payload
  // leaves the server, so no raw 8-hex card-id reaches the Boss-facing chat. Non-card
  // hex (git SHA, colour) is resolved-negative and passes through untouched.
  const safeText = sanitizeCardIds(text!, cardResolver, parse_mode)

  const payload: Record<string, unknown> = { chat_id: chatId, text: safeText }
  if (parse_mode) payload.parse_mode = parse_mode
  if (reply_to) payload.reply_to_message_id = reply_to

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      logger.warn({ status: resp.status, chat_id, path: '/api/notify/telegram' }, 'Telegram API error')
      // 409 Conflict pass-through (FIX-001, 820753e1): callers (per-agent bot-probe)
      // need to distinguish a bot-conflict 409 from other API errors to avoid
      // silently treating a conflict as a generic upstream failure. Return 409
      // verbatim so the per-agent probe can surface it; all other errors -> 502.
      const httpStatus = resp.status === 409 ? 409 : 502
      json(res, { error: `Telegram API ${resp.status}`, detail: errBody.slice(0, 200) }, httpStatus)
      return true
    }
    const result = await resp.json() as { ok: boolean; result?: { message_id: number } }
    json(res, { ok: true, message_id: result.result?.message_id ?? 0 })
  } catch (err) {
    logger.error({ err, chat_id }, 'notify/telegram: network error')
    json(res, { error: 'network error' }, 500)
  }
  return true
}
