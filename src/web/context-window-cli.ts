// One-shot CLI driver for the fleet context-window early-warning sweep (card
// fleet-context-early-warning). The standalone shell watchdog
// (scripts/telegram-pipe-watchdog.sh) invokes this once every 5 minutes; it runs
// a single sweep, prints a one-line verdict and exits 0 so the loop never wedges.
// The sweep is read-only on agents (transcripts in, one Bot-API alert out), so
// it runs regardless of dashboard state.

import { runContextSweep } from './context-window-watchdog.js'

async function main(): Promise<void> {
  try {
    const r = await runContextSweep()
    process.stdout.write(
      `context-sweep=done agents=${r.swept.length} high=${r.high.length}` +
        `${r.high.length ? ' [' + r.high.join(' ') + ']' : ''} alerted=${r.alerted.length}\n`,
    )
  } catch (err) {
    process.stdout.write(`context-sweep=error detail=${err instanceof Error ? err.message : String(err)}\n`)
  }
  // Always exit 0: a watchdog cycle failure must not crash the 5-min loop.
  process.exit(0)
}

void main()
