import { logger } from '../logger.js'
import { deleteOldMessages, MESSAGE_RETENTION_SEC } from '../db.js'

// Periodic retention sweep for agent_messages (card f1ea52c0, layer 3).
//
// The table otherwise grows without bound: delivered/done rows are never pruned
// and stale pending/failed rows linger (89 eight-day-old rows had to be deleted
// by hand on 2026-06-22, and thousands of delivered rows had accumulated). This
// drops every row past MESSAGE_RETENTION_SEC on a daily cadence. Errors on a
// tick are swallowed (logged) so the interval keeps running, mirroring the
// other maintenance sweeps (delivery-sentinel-maintenance, decay).
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000

export function startMessageRetentionSweep(opts: {
  intervalMs?: number
  retentionSec?: number
} = {}): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const retentionSec = opts.retentionSec ?? MESSAGE_RETENTION_SEC
  const run = (): void => {
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      const removed = deleteOldMessages(nowSec, retentionSec)
      if (removed > 0) {
        logger.info({ removed, retentionSec }, 'message-retention: pruned aged agent_messages rows')
      }
    } catch (err) {
      logger.warn({ err }, 'message-retention: sweep failed (non-fatal)')
    }
  }
  return setInterval(run, intervalMs)
}
