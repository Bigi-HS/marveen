// Token-free CONSUMER for the delivery ACK-overdue escalation (card 1a99b7e2).
//
// Invoked once per supervisor tick (throttled, flag-gated) as
// `node dist/delivery-ack-cli.js`. PR #133 writes the pending-ack trail on
// inject of an ack_expected message; the in-process observer
// (delivery-ack-observer.ts) appends a delivery-ack-cleared record once the
// recipient engages. This reads what remains OUTSTANDING (pending minus
// cleared), decides which acks are overdue past the 15-min window and NEW since
// its cursor (pure logic in delivery-ack.ts), and escalates them OUT OF BAND
// via the Telegram Bot API fallback -- the same dead-pipe-proof HTTPS path the
// watchdogs and the d37df625 abandonment consumer use. A wedged dashboard (no
// clears) only makes escalation MORE likely, which is the fail-safe direction.
//
// Boot-grace guard (card 4beb20b7 / A3'): after a restart the pending-ack trail
// may hold pre-restart ACKs that the observer would have cleared but didn't get
// to before the restart. To avoid false "receipt not confirmed" alerts, we skip
// escalation during the first ESCALATION_BOOT_GRACE_MS after server start and
// instead advance the cursor to the current high-water mark (same as baseline).
// The server writes its boot timestamp to SERVER_BOOT_AT_PATH on startup.
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
  DELIVERY_PENDING_ACK_SENTINEL,
  outstandingPendingAcks,
  selectAckEscalations,
  ackEscalationText,
  EMPTY_ACK_CURSOR,
  type AckEscalationCursor,
} from './web/delivery-ack.js'

const PROVIDER: ChannelProviderType = 'telegram'
const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()
const ALERT_CHAT_ID = process.env.WATCHDOG_ALERT_CHAT_ID ?? '8643929442'
const SENTINEL_PATH = join(PROJECT_ROOT, DELIVERY_PENDING_ACK_SENTINEL)
const CURSOR_PATH = join(PROJECT_ROOT, 'store', '.fleet-supervisor', 'delivery-ack.cursor')
export const SERVER_BOOT_AT_PATH = join(PROJECT_ROOT, 'store', '.fleet-supervisor', 'server-boot-at.txt')

// Grace period after server restart: skip escalation and advance cursor instead.
// 60s matches the card spec (~60s blind spot accepted; ACK_ESCALATION_WINDOW_MS=15min
// means no real ACK is missed -- it will be escalated on the next supervisor tick
// once the grace window has passed).
export const ESCALATION_BOOT_GRACE_MS = 60_000

// Returns true if the server started less than ESCALATION_BOOT_GRACE_MS ago.
// bootAt = 0 means the file is absent or unreadable (treat as no grace, i.e. false).
export function isWithinEscalationBootGrace(bootAt: number, nowMs: number): boolean {
  return bootAt > 0 && nowMs - bootAt < ESCALATION_BOOT_GRACE_MS
}

function readBootAt(): number {
  try {
    if (!existsSync(SERVER_BOOT_AT_PATH)) return 0
    const raw = readFileSync(SERVER_BOOT_AT_PATH, 'utf-8').trim()
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

function readMainToken(): string | null {
  try {
    const tokenPath = join(channelStateDir(PROVIDER, undefined), '.env')
    return readChannelToken(PROVIDER, tokenPath) || null
  } catch {
    return null
  }
}

function readCursor(): AckEscalationCursor {
  try {
    if (!existsSync(CURSOR_PATH)) return { ...EMPTY_ACK_CURSOR }
    const parsed = JSON.parse(readFileSync(CURSOR_PATH, 'utf-8'))
    const id = parsed && typeof parsed.lastEscalatedId === 'number' && Number.isFinite(parsed.lastEscalatedId)
      ? parsed.lastEscalatedId
      : 0
    return { lastEscalatedId: id }
  } catch (err) {
    logger.debug({ err }, 'delivery-ack: cursor read failed, starting from 0')
    return { ...EMPTY_ACK_CURSOR }
  }
}

function writeCursor(cursor: AckEscalationCursor): void {
  try {
    mkdirSync(dirname(CURSOR_PATH), { recursive: true })
    writeFileSync(CURSOR_PATH, JSON.stringify(cursor))
  } catch (err) {
    logger.warn({ err }, 'delivery-ack: cursor write failed')
  }
}

async function main(): Promise<void> {
  if (!existsSync(SENTINEL_PATH)) {
    // No ack_expected message has ever been injected -- nothing to consume.
    return
  }
  let raw: string
  try {
    raw = readFileSync(SENTINEL_PATH, 'utf-8')
  } catch (err) {
    logger.warn({ err }, 'delivery-ack: sentinel read failed')
    return
  }

  const outstanding = outstandingPendingAcks(raw)
  const cursor = readCursor()
  const nowMs = Date.now()
  const plan = selectAckEscalations(outstanding, cursor, nowMs)

  if (plan.baselined) {
    // First run on an existing trail: record the high-water mark, escalate
    // nothing (a deploy / pre-observer backlog must not replay).
    writeCursor(plan.nextCursor)
    logger.info(
      { through: plan.nextCursor.lastEscalatedId },
      'delivery-ack: baselined cursor past existing outstanding acks',
    )
    return
  }

  // Boot-grace guard (card 4beb20b7): if the server recently restarted, advance
  // the cursor past pre-restart outstanding ACKs without alerting -- the observer
  // may not have had time to write the cleared record before the restart.
  if (isWithinEscalationBootGrace(readBootAt(), nowMs)) {
    const maxId = outstanding.reduce((m, e) => Math.max(m, e.id), cursor.lastEscalatedId)
    if (maxId > cursor.lastEscalatedId) {
      writeCursor({ lastEscalatedId: maxId })
      logger.info(
        { through: maxId, graceMs: ESCALATION_BOOT_GRACE_MS },
        'delivery-ack: boot grace -- advanced cursor without escalating',
      )
    }
    return
  }

  if (plan.escalations.length === 0) return

  const token = readMainToken()
  if (!token) {
    logger.warn(
      { pending: plan.escalations.length },
      'delivery-ack: no bot token -- deferring escalation',
    )
    return
  }

  const text = ackEscalationText(plan.escalations)
  const sent = await sendFallbackAlert(token, ALERT_CHAT_ID, text).catch(() => false)
  if (sent) {
    writeCursor(plan.nextCursor)
    logger.info(
      { count: plan.escalations.length, through: plan.nextCursor.lastEscalatedId },
      'delivery-ack: escalated overdue acks out-of-band',
    )
  } else {
    // Do NOT advance the cursor -- retry the same batch next tick.
    logger.warn(
      { count: plan.escalations.length },
      'delivery-ack: Telegram fallback send failed -- will retry next tick',
    )
  }
}

main().catch((err) => {
  logger.error({ err }, 'delivery-ack: unexpected failure')
  process.exitCode = 1
})
