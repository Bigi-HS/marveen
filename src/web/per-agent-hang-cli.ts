// One-shot CLI driver for the per-agent HANG sweep (card 31ab64fe Part 1).
// The shell loop (scripts/telegram-pipe-watchdog.sh) invokes this once per cycle.
// It recovers a WEDGED Telegram socketpair (an MCP tool_use that hangs with no
// tool_result) -- the symptom no other layer detects. Unlike the liveness sweep
// it runs REGARDLESS of dashboard state (no overlap with the in-process monitor).
// Prints a one-line verdict and exits 0 so the loop never wedges.

import { runHangSweep } from './per-agent-pipe-watchdog.js'

function main(): void {
  try {
    const r = runHangSweep()
    const hung = Object.entries(r.results)
      .filter(([, v]) => v.state === 'hung')
      .map(([n]) => n)
    process.stdout.write(
      `hang-sweep=done agents=${r.swept.length} hung=${hung.length}${hung.length ? ' [' + hung.join(' ') + ']' : ''} recovered=${r.recovered.length}\n`,
    )
  } catch (err) {
    process.stdout.write(`hang-sweep=error detail=${err instanceof Error ? err.message : String(err)}\n`)
  }
  process.exit(0)
}

main()
