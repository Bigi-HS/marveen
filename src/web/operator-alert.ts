// Shared operator-alert delivery seam.
//
// Extracted from pending-retry-alert.ts when a second scheduler alert (the
// stuck-next_run sentinel) needed the same send path. It lives on its own
// rather than being re-exported from one feature's module so that importing
// the seam does not imply importing that feature.
//
// The seam exists so a test can never send a real Telegram message: every
// caller takes `deliver` as a parameter defaulting to `defaultDeliver`, and
// every test passes its own.
import { join } from 'node:path'
import { PROJECT_ROOT, ALLOWED_CHAT_ID } from '../config.js'
import { readFileOr } from './agent-config.js'
import { sendTelegramMessage } from './telegram.js'

/** Delivery seam. Injected in tests; defaults to the real Telegram send. */
export type AlertDeliver = (text: string) => Promise<void>

/**
 * Real delivery. Rejects with `Telegram API <code>: ...` shaped messages for
 * local misconfiguration too, so `classifyTelegramSendError` can sort a
 * missing token (permanent) from a network blip (transient) without the
 * caller having to special-case config errors.
 */
export function defaultDeliver(text: string): Promise<void> {
  const envContent = readFileOr(join(PROJECT_ROOT, '.env'), '')
  const token = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/)?.[1]?.trim()
  if (!token) return Promise.reject(new Error('Telegram API 401: no TELEGRAM_BOT_TOKEN'))
  if (!ALLOWED_CHAT_ID.trim()) return Promise.reject(new Error('Telegram API 400: empty ALLOWED_CHAT_ID'))
  return sendTelegramMessage(token, ALLOWED_CHAT_ID, text)
}
