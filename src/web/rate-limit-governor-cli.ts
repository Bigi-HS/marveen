// One-shot CLI driver for the rate-limit governor (notify-first MVP, card
// fd30873b). A scheduler (cron or the telegram-pipe-watchdog shell loop) invokes
// this once per cycle. It reads the latest status-line snapshot, decides whether
// the five-hour window crossed 96% (pause notice) or recovered (resume notice),
// delivers any notice to Genesis as an inter-agent message, persists episode
// state, prints a one-line verdict and exits 0 so it never wedges its caller.
//
// NOTE: this only NOTIFIES. Actually pausing the fleet is a separate Boss-gated
// step and is not wired here. The governor is also not yet attached to any live
// loop -- activation is a follow-up after the gate and a dry-run validation.

import { createAgentMessage } from '../db.js'
import { logger } from '../logger.js'
import {
  runGovernorCycle,
  readSnapshotFile,
  readStateFile,
  writeStateFile,
  type GovernorState,
} from './rate-limit-governor.js'

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
