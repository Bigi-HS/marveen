// One-shot CLI driver for the Telegram pipe watchdog. The standalone shell
// watchdog (scripts/telegram-pipe-watchdog.sh) invokes this once every 5
// minutes; it runs a single cycle, prints a one-line verdict, and exits 0 so
// the shell loop never wedges on it. All recovery/escalation/logging lives in
// runCycle().

import { runCycle } from './telegram-pipe-watchdog.js'

async function main(): Promise<void> {
  try {
    const res = await runCycle()
    // Single machine-greppable status line for the shell driver's own log.
    process.stdout.write(
      `verdict=${res.verdict} recovered=${res.recovered} escalated=${res.escalated} ` +
        `consecutiveDead=${res.state.consecutiveDead} alerted=${res.state.alerted}\n`,
    )
  } catch (err) {
    process.stdout.write(`verdict=error detail=${err instanceof Error ? err.message : String(err)}\n`)
  }
  // Always exit 0: a watchdog cycle failure must not crash the 5-min loop.
  process.exit(0)
}

void main()
