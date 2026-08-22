// In-process CLEAR observer for the delivery ACK protocol (card 1a99b7e2).
//
// On a 2s tick it reads the pending-ack trail (store/.delivery-pending-ack
// .jsonl, written by the router on inject of an ack_expected message), and for
// every ack still OUTSTANDING checks whether the recipient pane is BUSY. A busy
// pane means a turn is running, and because the router only injects into an
// IDLE pane (serialized, single injector), that turn is the receipt of OUR
// message -- see the load-bearing invariant on selectAcksToClear. It then
// appends a delivery-ack-cleared record, so the escalation consumer stops
// counting that ack as outstanding.
//
// Boot-grace guard (card 6e81183f): the observer skips clearing during the
// first BOOT_GRACE_MS after startAckClearObserver() is called. A stale
// pane-busy observation from a pre-restart turn would otherwise false-clear
// a pending ACK whose inject happened before the restart. The grace period
// lets pre-restart turns settle to idle before we start clearing.
//
// Side-effect-free in the user-visible sense: it only ever appends to the
// gitignored sentinel and only when ack_expected messages exist (the file is
// absent otherwise -> early return). So it is naturally inert until a sender
// opts into ack_expected, and needs no activation flag. The OUT-OF-BAND
// escalation (the part with an external Telegram effect) is what is gated.
//
// All IO is here; the decision (selectAcksToClear) is pure and unit-tested.

import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { capturePane, agentSessionName } from './agent-process.js'
import { detectPaneState } from '../pane-state.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import {
  DELIVERY_PENDING_ACK_SENTINEL,
  outstandingPendingAcks,
  selectAcksToClear,
  ackClearedRecord,
} from './delivery-ack.js'

const MARVEEN_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()
// 2s (was 5s): a very fast recipient engagement (~1s, "Cogitated for 1s") can
// finish entirely BETWEEN two polls, so the pane is no longer busy when we
// observe and the ack never clears -> a FALSE 15-min escalation (card ae09fc73,
// repro msgs 2906/2919). Tightening the cadence shrinks that race window so a
// ~1s turn is far more likely to be caught mid-flight. This is a soft-alert
// correctness fix only -- the 15-min escalation threshold and the
// abandonment/drop semantics are unchanged.
const ACK_CLEAR_POLL_MS = 2000

// Boot-grace: panes can be "busy" from a pre-restart turn for up to ~10s after
// boot (the old server's last active turn may still be running when the new
// server starts). 15s is conservative enough to cover that window without
// introducing meaningful latency for real-turn detection.
export const BOOT_GRACE_MS = 15_000

// Recipient name -> tmux session. Mirrors the router's resolution: the main
// agent runs in `${MAIN_AGENT_ID}-channels`, every sub-agent in `agent-${name}`.
function recipientSession(to: string): string {
  return to === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(to)
}

// "Engaged" = the pane is BUSY (a turn is running). A missing pane (dead /
// not launched) or an idle/typing/unknown/error pane is NOT engagement: such an
// ack stays outstanding and escalates at the 15-min window. Conservative on
// purpose -- only an unambiguous busy turn clears an ack.
//
// CROSS-INJECTOR RESIDUAL (benign): an OUT-of-process injector -- the
// recipient's own channel plugin handling a real inbound message, or a human
// operator -- can flip the pane busy in the 5s gap between our inject and this
// observation, which would clear the ack via a turn that is not ours (a
// false-clear). This is harmless: our message was already successfully injected
// into the recipient's input buffer, so ceasing to track it loses nothing, and
// a genuinely dropped/wedged delivery (recipient never engages at all) is still
// caught by the d37df625 1h-abandonment net. The in-PROCESS injectors cannot
// cause this -- they are serialized on the same JS thread as the router (see
// the idle-only inject gate invariant in message-router.ts).
function defaultRecipientBusy(to: string): boolean {
  const pane = capturePane(recipientSession(to))
  if (pane == null) return false
  return detectPaneState(pane) === 'busy'
}

// Injectable seam: tracks the bootStartedAt timestamp so __resetAckObserverState
// can clear it between tests.
let _bootStartedAt: number | null = null

export function __resetAckObserverState(): void {
  _bootStartedAt = null
}

export type AckObserverDeps = {
  readAckFile?: () => string | null
  recipientBusy?: (to: string) => boolean
  appendRecord?: (record: string) => void
  nowMs?: () => number
}

export function startAckClearObserver(opts: AckObserverDeps = {}): NodeJS.Timeout {
  const nowMs = opts.nowMs ?? (() => Date.now())
  _bootStartedAt = nowMs()
  const bootStartedAt = _bootStartedAt

  const path = join(MARVEEN_ROOT, DELIVERY_PENDING_ACK_SENTINEL)

  const readAckFile = opts.readAckFile ?? (() => {
    if (!existsSync(path)) return null
    try { return readFileSync(path, 'utf-8') } catch { return null }
  })

  const recipientBusyFn = opts.recipientBusy ?? defaultRecipientBusy

  const appendRecordFn = opts.appendRecord ?? ((record: string) => {
    appendFileSync(path, record)
  })

  return setInterval(() => {
    // Boot-grace guard (card 6e81183f): skip clearing until pre-restart
    // pane-busy observations have had time to settle.
    if (nowMs() - bootStartedAt < BOOT_GRACE_MS) return

    const raw = readAckFile()
    if (raw == null) return

    const outstanding = outstandingPendingAcks(raw)
    if (outstanding.length === 0) return

    // Memoise the busy check per recipient so several acks to the same agent
    // cost one capture-pane, not one per ack.
    const busyCache = new Map<string, boolean>()
    const isBusy = (to: string): boolean => {
      const hit = busyCache.get(to)
      if (hit !== undefined) return hit
      const b = recipientBusyFn(to)
      busyCache.set(to, b)
      return b
    }

    const now = nowMs()
    const toClear = selectAcksToClear(outstanding, isBusy, now)
    if (toClear.length === 0) return

    for (const id of toClear) {
      try {
        appendRecordFn(ackClearedRecord(id, now) + '\n')
      } catch (err) {
        logger.warn({ err, id }, 'ack-observer: failed to append cleared record')
      }
    }
    logger.info({ count: toClear.length, ids: toClear }, 'ack-observer: cleared pending acks (recipient engaged)')
  }, ACK_CLEAR_POLL_MS)
}
