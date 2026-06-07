// One-shot CLI driver for the token-outage auto-ACK bridge (P3). The standalone
// shell loop (scripts/token-outage-watch.sh) invokes this every ~30s; it runs a
// single edge-triggered cycle, prints a greppable status line, and exits 0 so the
// loop never wedges. Zero Claude tokens: detection is capture-pane, the only
// outbound is a direct Bot-API sendMessage and (on reset) a --continue respawn.

import { runCycle } from './token-outage-bridge.js'

async function main(): Promise<void> {
  try {
    const r = await runCycle()
    process.stdout.write(
      `token-outage=ok limited=${r.state.limited} transition=${r.transition} ` +
        `acked=${r.acked} captured=${r.captured} redispatched=${r.redispatched}\n`,
    )
  } catch (err) {
    process.stdout.write(`token-outage=error detail=${err instanceof Error ? err.message : String(err)}\n`)
  }
  process.exit(0)
}

void main()
