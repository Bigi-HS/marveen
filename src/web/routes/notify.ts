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

  const payload: Record<string, unknown> = { chat_id: chatId, text }
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
      json(res, { error: `Telegram API ${resp.status}`, detail: errBody.slice(0, 200) }, 502)
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
