// Buster-SCOPED sim driver for the per-agent pipe-watchdog (card 31ab64fe Part 2
// LIVE-activation gate). Invoked ONLY by scripts/per-agent-watchdog-buster-sim.sh.
//
// Safety: this forces the dashboard-down sweep path AND hard-restricts the sweep
// to ONLY 'buster' via the injected listChannelSubAgents dep, so the other 5 live
// channel agents are GUARANTEED untouched (the real listChannelSubAgents() would
// return all of them; we never call it here). runAgentCycle is the REAL one --
// real 409/presence probe + real attemptChannelMcpReconnect against agent-buster
// -- so the sim exercises the genuine target-selection + recovery, just scoped.
//
// Prints one machine-greppable SIM_RESULT=<json> line for the shell harness.
import { runSubAgentSweep, runAgentCycle } from '../dist/web/per-agent-pipe-watchdog.js'

const TARGET = process.env.SIM_TARGET_AGENT || 'buster'
if (TARGET !== 'buster') {
  // Defence in depth: this driver must never be repurposed against a live agent.
  process.stderr.write(`refusing: sim driver is buster-only, got "${TARGET}"\n`)
  process.exit(2)
}

const res = await runSubAgentSweep(Date.now(), {
  isDashboardUp: async () => false, // force the dashboard-DOWN sweep path
  listChannelSubAgents: () => [TARGET], // HARD scope: buster only, never the live 5
  runAgentCycle, // real probe + real /mcp recovery, for buster
})
process.stdout.write('SIM_RESULT=' + JSON.stringify(res) + '\n')
