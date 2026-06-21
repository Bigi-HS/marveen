// Maintenance for the delivery sentinel JSONL trails (card 681f99b0 / A2 +
// ef8ae6b5 / A3). Both trails under store/ are append-only and were never bounded:
//   - the pending-ack trail (.delivery-pending-ack.jsonl) grows by a
//     pending+cleared PAIR per received ack, so it is FOLDED -- rewritten to the
//     still-outstanding acks, reconciled against the DB so a done/failed message
//     no longer owes a receipt (dampens the A3 restart-window false escalation).
//   - the abandonment trail (.delivery-abandonment-alerts.jsonl) has no fold
//     collapse (every row is a distinct event), so it is only SIZE-CAPPED to its
//     newest rows.
//
// compactDeliverySentinelsOnBoot() runs once at server boot, before the ACK
// clear-observer starts, so the observer reads the freshly-compacted file.
// startDeliverySentinelMaintenance() (card ef8ae6b5) adds a periodic live
// rotation so long-uptime servers do not accumulate unbounded JSONL growth.
// The pure decisions live in delivery-ack.ts / delivery-alert.ts and are
// unit-tested; this module is the IO seam. Every step is wrapped so a
// maintenance failure never blocks startup. Writes are atomic (tmp + rename)
// so a crash mid-rewrite cannot leave a torn trail.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { getMessageStatusesByIds } from '../db.js'
import {
  DELIVERY_PENDING_ACK_SENTINEL,
  parsePendingAckSentinel,
  compactPendingAckSentinel,
} from './delivery-ack.js'
import { DELIVERY_ABANDONMENT_SENTINEL, capJsonlTrail } from './delivery-alert.js'

const MARVEEN_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()

// A message in one of these statuses no longer owes a receipt: done = recipient
// completed (=> received), failed = delivery gave up (owned by the abandonment
// net). Such an outstanding ack is reconciled away by the fold.
const TERMINAL_STATUSES = new Set(['done', 'failed'])

// Hard backstop cap for the abandonment trail. The pre-gate bundle WARNs at >500
// lines; the cap is well above steady-state so a genuine escalation backlog is
// never truncated mid-flight, only runaway accumulation is bounded.
const MAX_ABANDONMENT_LINES = 2000

export function compactDeliverySentinelsOnBoot(): void {
  compactPendingAckTrail()
  capAbandonmentTrail()
}

// Injectable seam for unit tests -- replaced in tests to avoid real I/O.
let _maintenanceFn: () => void = () => {
  compactPendingAckTrail()
  capAbandonmentTrail()
}

export function __resetMaintenanceState(): void {
  _maintenanceFn = () => {
    compactPendingAckTrail()
    capAbandonmentTrail()
  }
}

// Starts a periodic maintenance interval (card ef8ae6b5). Runs the same
// compaction + cap that boot-time maintenance does, on a regular cadence so
// long-uptime servers cannot accumulate unbounded JSONL growth. Errors on any
// individual tick are swallowed (logged) so the interval keeps running.
// Returns the handle for the caller to clearInterval in server.close().
export function startDeliverySentinelMaintenance(opts: {
  intervalMs?: number
  _maintenanceFn?: () => void
} = {}): NodeJS.Timeout {
  if (opts._maintenanceFn) _maintenanceFn = opts._maintenanceFn
  const intervalMs = opts.intervalMs ?? 60 * 60 * 1000
  return setInterval(() => {
    try {
      _maintenanceFn()
    } catch (err) {
      logger.warn({ err }, 'sentinel-maintenance: periodic compaction failed (non-fatal)')
    }
  }, intervalMs)
}

function compactPendingAckTrail(): void {
  try {
    const path = join(MARVEEN_ROOT, DELIVERY_PENDING_ACK_SENTINEL)
    if (!existsSync(path)) return
    const raw = readFileSync(path, 'utf-8')
    const ids = parsePendingAckSentinel(raw).map((p) => p.id)
    const statuses = getMessageStatusesByIds(ids)
    const isTerminal = (id: number): boolean => TERMINAL_STATUSES.has(statuses.get(id) ?? '')
    const compacted = compactPendingAckSentinel(raw, isTerminal)
    if (compacted !== raw) {
      atomicWriteFileSync(path, compacted)
      logger.info(
        { beforeBytes: raw.length, afterBytes: compacted.length },
        'boot: folded pending-ack trail (cleared pairs collapsed + terminal reconciled)',
      )
    }
  } catch (err) {
    logger.warn({ err }, 'boot: pending-ack trail fold failed (non-fatal)')
  }
}

function capAbandonmentTrail(): void {
  try {
    const path = join(MARVEEN_ROOT, DELIVERY_ABANDONMENT_SENTINEL)
    if (!existsSync(path)) return
    const raw = readFileSync(path, 'utf-8')
    const capped = capJsonlTrail(raw, MAX_ABANDONMENT_LINES)
    if (capped !== null) {
      atomicWriteFileSync(path, capped)
      logger.info(
        { beforeBytes: raw.length, afterBytes: capped.length, cap: MAX_ABANDONMENT_LINES },
        'boot: capped abandonment trail to newest rows',
      )
    }
  } catch (err) {
    logger.warn({ err }, 'boot: abandonment trail cap failed (non-fatal)')
  }
}
