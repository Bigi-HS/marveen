// per-agent-pipe-probe-cli -- READ-ONLY single-agent liveness probe (card acd7fa13).
//
// Prints `verdict=<healthy|dead|inconclusive>` for ONE agent and exits 0 on a
// clean probe, with NO state write, NO recovery, NO escalation. This is the live
// re-probe that scripts/pipe-watchdog-staleness-check.py (n8n Tier-A alert path)
// shells out to before firing a STALE alert off the cached .state.json. A stale
// flush-artifact can hand many agents the SAME old lastHealthyTs while
// lastCheckedTs is recent, so the age-based branch fires STALE falsely for all
// of them (repro 2026-09-21). Trusting the cache is the bug; this re-probe is the
// live verification.
//
// The probe orchestration below is a DELIBERATE ~15-line copy of the probe
// portion of runAgentCycle() in per-agent-pipe-watchdog.ts (~lines 162-181):
// resolve provider -> read the agent's OWN bot token -> presence probe ->
// bounded conflict-probe retries -> assessPipeLiveness. It stops BEFORE
// runAgentCycle's persist/recover/escalate side effects. The duplication is
// intentional (plan acd7fa13, Option B): keeping the live watchdog path
// UNTOUCHED beats extracting a shared helper that would widen the blast radius
// for marginal DRY. If you change the probe cadence or the verdict inputs in
// runAgentCycle, mirror the change here.

import { join } from 'node:path'
import { channelStateDir, readChannelToken, type ChannelProviderType } from '../channel-provider.js'
import { probeTelegramConflict } from './channel-conflict-probe.js'
import { probeChannelPollerPresence } from './channel-poller-reap.js'
import { resolveAgentProviderType } from './channel-mcp-reconnect.js'
import { agentDir } from './agent-config.js'
import { assessPipeLiveness, reduceConflictProbes, type PipeLiveness } from './telegram-pipe-watchdog.js'

// Mirror per-agent-pipe-watchdog.ts CONFLICT_PROBE_RETRIES / _GAP_MS so the
// re-probe uses the same anti-flap cadence as the live watchdog.
const CONFLICT_PROBE_RETRIES = 3
const CONFLICT_PROBE_GAP_MS = 2000

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Mirror of the private readAgentToken in per-agent-pipe-watchdog.ts: the agent's
// OWN bot token lives under the real .claude channel dir (NOT .claude-config,
// which symlinks to the shared main token and would yield the WRONG token).
function readAgentToken(name: string, provider: ChannelProviderType): string | null {
  try {
    const tokenPath = join(channelStateDir(provider, agentDir(name)), '.env')
    return readChannelToken(provider, tokenPath) || null
  } catch {
    return null
  }
}

// Read-only liveness verdict for one agent. Same inputs/decision as the live
// watchdog cycle; NONE of its side effects.
export async function probeAgentVerdict(name: string): Promise<PipeLiveness> {
  const provider = resolveAgentProviderType(name)
  const token = readAgentToken(name, provider)

  const present = probeChannelPollerPresence(provider, agentDir(name))
  let conflicted = false
  let probeStatus = 0
  if (token) {
    const results: { conflicted: boolean; status: number }[] = []
    for (let i = 0; i < CONFLICT_PROBE_RETRIES; i++) {
      const probe = await probeTelegramConflict(token)
      results.push({ conflicted: probe.conflicted, status: probe.status })
      if (probe.conflicted) break
      if (i < CONFLICT_PROBE_RETRIES - 1) await sleep(CONFLICT_PROBE_GAP_MS)
    }
    const agg = reduceConflictProbes(results)
    conflicted = agg.conflicted
    probeStatus = agg.status
  }

  return assessPipeLiveness({ present, conflicted, probeStatus })
}

async function main(argv: string[]): Promise<number> {
  const name = argv[0]
  if (!name) {
    process.stderr.write('usage: per-agent-pipe-probe-cli <agent>\n')
    // Non-zero -> the python guard FAILS OPEN (keeps the alert) rather than
    // silently suppressing a real outage on a mis-invocation.
    return 2
  }
  try {
    const verdict = await probeAgentVerdict(name)
    process.stdout.write(`verdict=${verdict}\n`)
    return 0
  } catch (err) {
    // Any probe failure -> non-zero so the caller fails OPEN. Never suppress an
    // alert because WE could not probe.
    process.stderr.write(`probe-error: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

void main(process.argv.slice(2)).then(code => process.exit(code))
