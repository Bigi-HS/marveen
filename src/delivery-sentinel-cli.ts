// Token-free CONSUMER for the delivery-abandonment sentinel (card d37df625).
//
// Invoked once per supervisor tick (throttled) as `node dist/delivery-sentinel
// -cli.js`. It reads the durable abandonment trail PR #130 writes, decides
// which lines are NEW since its persisted cursor (pure logic in
// delivery-sentinel-consumer.ts), and escalates them OUT OF BAND via the
// Telegram Bot API fallback -- the same dead-pipe-proof HTTPS path the
// watchdogs use. This turns a silent multi-hour drop into a minutes-latency
// operator ping, even when the in-band inter-agent alert is itself lost.
//
// All side effects are here; the decision is pure and unit-tested. The cursor
// advances ONLY after a successful send (or a baseline), so a failed Telegram
// call is retried on the next tick rather than swallowed.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { logger } from './logger.js'
import { channelStateDir, readChannelToken, type ChannelProviderType } from './channel-provider.js'
import { sendFallbackAlert } from './web/telegram-pipe-watchdog.js'
import {
  DELIVERY_ABANDONMENT_SENTINEL,
  parseAbandonmentSentinel,
} from './web/delivery-alert.js'
import {
  EMPTY_SENTINEL_CURSOR,
  selectSentinelEscalations,
  sentinelAlertText,
  type SentinelCursor,
} from './web/delivery-sentinel-consumer.js'

const PROVIDER: ChannelProviderType = 'telegram'
const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()
const ALERT_CHAT_ID = process.env.WATCHDOG_ALERT_CHAT_ID ?? '8643929442'
const SENTINEL_PATH = join(PROJECT_ROOT, DELIVERY_ABANDONMENT_SENTINEL)
const CURSOR_PATH = join(PROJECT_ROOT, 'store', '.fleet-supervisor', 'delivery-sentinel.cursor')

function readMainToken(): string | null {
  try {
    const tokenPath = join(channelStateDir(PROVIDER, undefined), '.env')
    return readChannelToken(PROVIDER, tokenPath) || null
  } catch {
    return null
  }
}

function readCursor(): SentinelCursor {
  try {
    if (!existsSync(CURSOR_PATH)) return { ...EMPTY_SENTINEL_CURSOR }
    const parsed = JSON.parse(readFileSync(CURSOR_PATH, 'utf-8'))
    const id = parsed && typeof parsed.lastEscalatedId === 'number' && Number.isFinite(parsed.lastEscalatedId)
      ? parsed.lastEscalatedId
      : 0
    return { lastEscalatedId: id }
  } catch (err) {
    logger.debug({ err }, 'delivery-sentinel: cursor read failed, starting from 0')
    return { ...EMPTY_SENTINEL_CURSOR }
  }
}

function writeCursor(cursor: SentinelCursor): void {
  try {
    mkdirSync(dirname(CURSOR_PATH), { recursive: true })
    writeFileSync(CURSOR_PATH, JSON.stringify(cursor))
  } catch (err) {
    logger.warn({ err }, 'delivery-sentinel: cursor write failed')
  }
}

async function main(): Promise<void> {
  if (!existsSync(SENTINEL_PATH)) {
    // No abandonment has ever been recorded -- nothing to consume.
    return
  }
  let raw: string
  try {
    raw = readFileSync(SENTINEL_PATH, 'utf-8')
  } catch (err) {
    logger.warn({ err }, 'delivery-sentinel: sentinel read failed')
    return
  }

  const events = parseAbandonmentSentinel(raw)
  const cursor = readCursor()
  const plan = selectSentinelEscalations(events, cursor)

  if (plan.baselined) {
    // First run on existing history: record the high-water mark, escalate
    // nothing (a deploy must not replay historical drops).
    writeCursor(plan.nextCursor)
    logger.info(
      { through: plan.nextCursor.lastEscalatedId },
      'delivery-sentinel: baselined cursor past existing history',
    )
    return
  }

  if (plan.escalations.length === 0) return

  const token = readMainToken()
  if (!token) {
    // Cannot escalate without a bot token; leave the cursor so the next tick
    // retries once the token is available.
    logger.warn(
      { pending: plan.escalations.length },
      'delivery-sentinel: no bot token -- deferring escalation',
    )
    return
  }

  const text = sentinelAlertText(plan.escalations)
  const sent = await sendFallbackAlert(token, ALERT_CHAT_ID, text).catch(() => false)
  if (sent) {
    writeCursor(plan.nextCursor)
    logger.info(
      { count: plan.escalations.length, through: plan.nextCursor.lastEscalatedId },
      'delivery-sentinel: escalated abandoned deliveries out-of-band',
    )
  } else {
    // Do NOT advance the cursor -- retry the same batch next tick.
    logger.warn(
      { count: plan.escalations.length },
      'delivery-sentinel: Telegram fallback send failed -- will retry next tick',
    )
  }
}

main().catch((err) => {
  logger.error({ err }, 'delivery-sentinel: unexpected failure')
  process.exitCode = 1
})
