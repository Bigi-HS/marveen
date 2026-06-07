// One-shot CLI driver for the per-agent (sub-agent) Telegram pipe watchdog.
// The shell loop (scripts/telegram-pipe-watchdog.sh) invokes this once per
// cycle, after the main orchestrator cycle. It runs a single sweep, prints a
// one-line verdict, and exits 0 so the shell loop never wedges on it. The sweep
// is a no-op while the dashboard is up (the in-process monitor owns recovery
// then); it only acts in the dashboard-down window.

import { runSubAgentSweep } from './per-agent-pipe-watchdog.js'

async function main(): Promise<void> {
  try {
    const res = await runSubAgentSweep()
    if (res.skipped) {
      process.stdout.write(`sweep=skipped reason=${res.reason}\n`)
    } else {
      const parts = Object.entries(res.results).map(
        ([name, r]) => `${name}:${r.verdict}${r.recovered ? '+recovered' : ''}${r.escalated ? '+escalated' : ''}`,
      )
      process.stdout.write(`sweep=done agents=${parts.length} ${parts.join(' ')}\n`)
    }
  } catch (err) {
    process.stdout.write(`sweep=error detail=${err instanceof Error ? err.message : String(err)}\n`)
  }
  // Always exit 0: a watchdog cycle failure must not crash the shell loop.
  process.exit(0)
}

void main()
