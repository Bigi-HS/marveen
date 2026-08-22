// One-shot CLI driver for the rate-limit governor (card fd30873b). A scheduler
// (cron or the telegram-pipe-watchdog shell loop) invokes this once per cycle.
// It reads the latest status-line snapshot, decides whether the five-hour window
// crossed 98% (pause) or recovered (resume), declares/clears the fleet-pause
// SENTINEL, notifies Genesis, persists episode state, prints a one-line verdict
// and exits 0 so it never wedges its caller.
//
// SCOPE (Boss-gated, #50/#81 pattern): this declares the pause STATE (the
// sentinel) + notifies. It does NOT enforce -- no supervisor/scheduler honours
// the sentinel yet, so writing it pauses NOTHING. Making the fleet actually hold
// on isFleetPaused() is the SEPARATE live-activation step, gated + dry-run-
// validated after this lands. The governor is also not attached to any live loop
// yet. So merging this is zero-blast-radius.

import { createAgentMessage } from '../db.js'
import { logger } from '../logger.js'
import {
  runGovernorCycle,
  readSnapshotFile,
  readStateFile,
  writeStateFile,
  type GovernorState,
} from './rate-limit-governor.js'
import { writeFleetPause, clearFleetPause, type FleetPauseRecord } from './fleet-pause.js'

// Genesis owns the operator's Telegram channel, so the governor reports to it
// rather than messaging Dominik directly (the fleet's report-to-Genesis rule).
const NOTIFY_FROM = 'rate-limit-governor'
const NOTIFY_TO = 'marveen'

function main(): void {
  try {
    const res = runGovernorCycle({
      readSnapshot: () => readSnapshotFile(),
      readState: () => readStateFile(),
      writeState: (state: GovernorState) => writeStateFile(state),
      notify: (message: string) => {
        createAgentMessage(NOTIFY_FROM, NOTIFY_TO, message)
        logger.info({ to: NOTIFY_TO }, 'rate-limit-governor: notification sent')
      },
      nowSec: () => Math.floor(Date.now() / 1000),
      pauseFleet: (record: FleetPauseRecord) => {
        writeFleetPause(record)
        logger.warn({ resumeAt: record.resumeAt, pct: record.pct }, 'rate-limit-governor: fleet-pause sentinel written (state-only; no enforcer wired yet)')
      },
      resumeFleet: () => {
        clearFleetPause()
        logger.info('rate-limit-governor: fleet-pause sentinel cleared')
      },
    })
    const pct = res.pct === null ? 'n/a' : `${res.pct}%`
    process.stdout.write(`governor action=${res.action} pct=${pct}\n`)
  } catch (err) {
    process.stdout.write(`governor action=error detail=${err instanceof Error ? err.message : String(err)}\n`)
  }
  // Always exit 0: a governor cycle failure must not crash its scheduler.
  process.exit(0)
}

main()
