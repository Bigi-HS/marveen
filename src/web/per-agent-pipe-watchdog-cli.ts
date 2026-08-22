// One-shot CLI driver for the per-agent (sub-agent) Telegram pipe watchdog.
// The shell loop (scripts/telegram-pipe-watchdog.sh) invokes this once per
// cycle, after the main orchestrator cycle. It runs both sweeps and exits 0 so
// the shell loop never wedges on it:
//   - the liveness sweep (no-op while the dashboard is up; the in-process
//     monitor owns recovery then -- only acts in the dashboard-down window);
//   - the HANG sweep (card 31ab64fe Part 1): drives /mcp recovery on a WEDGED
//     Telegram MCP call, the symptom no other layer sees. It runs regardless of
//     dashboard state, since a hang overlaps with nothing the monitor catches.

import { runWatchdogSweeps } from './per-agent-pipe-watchdog.js'

async function main(): Promise<void> {
  try {
    for (const line of await runWatchdogSweeps()) {
      process.stdout.write(`${line}\n`)
    }
  } catch (err) {
    process.stdout.write(`watchdog=error detail=${err instanceof Error ? err.message : String(err)}\n`)
  }
  // Always exit 0: a watchdog cycle failure must not crash the shell loop.
  process.exit(0)
}

void main()
