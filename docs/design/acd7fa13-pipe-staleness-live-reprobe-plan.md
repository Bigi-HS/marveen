# acd7fa13 — pipe-watchdog staleness-check: live re-probe before alert (impl plan)

Owner: dave (impl), forge (coordinates). Status: PLAN (code-explorer done 2026-09-29, pre-TDD).
Gate: fleet-alerting path -> c12-Buster + Thor+Dave gate. Blast radius = false/missed ALERT (not session-kill).

## Problem (repro 2026-09-21)
`scripts/pipe-watchdog-staleness-check.py` (n8n Tier-A alert path) alerts straight off the
`store/*.state.json` cache. A stale `.state.json` flush-artifact gave 5 agents the SAME old
`lastHealthyTs` while `lastCheckedTs` was recent -> the age-based branch fired STALE for all 5
falsely. The alert trusts the cache; it never live-verifies.

## Execution path (as-is)
`pipe-watchdog-staleness-check.py:main()`
- globs `store/pipe-watchdog.*.state.json` + `telegram-pipe-watchdog.state.json`
- per agent reads `lastHealthyTs`, `lastCheckedTs`, `consecutiveDead`
- skip if `now - lastCheckedTs > 2h` (stale DATA guard) or parked (watchdog chmod -x)
- **STALE if `consecutiveDead >= 2` OR `age(lastHealthyTs) > stale_minutes` (default 90)** (line 170)
- alert branch: inter-agent to marveen, 23h re-alert suppression (line 201-227)

The two STALE triggers differ in trust:
- `consecutiveDead >= 2` = the watchdog's OWN repeated live probes said dead -> trustworthy.
- `age(lastHealthyTs) > threshold` (with lastCheckedTs recent) = the CACHE-ARTIFACT-prone branch
  -> this is the false-positive source. **This is the branch to live-verify.**

## Existing TS reuse surface (src/web/per-agent-pipe-watchdog.ts)
- `runAgentCycle(name, now)` -> CycleResult: real probe (present + N conflict probes) ->
  `assessPipeLiveness({present, conflicted, probeStatus})` -> verdict 'dead'|'healthy'|'inconclusive'
  (409 = healthy authority; present=false / steady-200 = dead). SIDE EFFECTS: persists state,
  logs, and on 'dead' runs the recovery/escalation ladder.
- `assessPipeLiveness(...)` = PURE verdict fn (no I/O) — the read-only core.
- `runStaleHealthSweep()` already live-probes agents whose `lastCheckedTs` is stale — BUT it
  classifies on `lastCheckedTs`, so the false-STALE case (recent lastCheckedTs + OLD lastHealthyTs)
  is 'fresh' to it and SKIPPED. So runStaleHealthSweep does NOT cover this card. Confirmed.
- `per-agent-pipe-watchdog-cli.ts` runs ALL sweeps + exits 0 — NOT a single-agent verdict. The
  card's "run the existing CLI" phrasing is approximate; a targeted per-agent probe is needed.

## Design fork (CLARIFYING-Q for forge before TDD)
How should the python alert path get a live per-agent verdict?
- **Option A (reuse, lowest-LOC):** shell out `node -e "runAgentCycle('<agent>')"`, then re-read the
  freshly-persisted `.state.json` and re-evaluate. Reuses canonical path. DOWNSIDE: `runAgentCycle`
  has recovery/escalation SIDE EFFECTS — an alerting cron would now also *recover*, doubling with
  the watchdog loop. Mixing alert + recovery in the Tier-A path is a concern.
- **Option B (clean separation, small new code):** add a thin single-agent PROBE-ONLY CLI entry
  (present + conflict probe + `assessPipeLiveness`, NO recovery, prints `verdict=dead|healthy|
  inconclusive`). Python shells out per STALE (age-branch) agent; alert ONLY if `verdict==dead`.
  Alerting stays read-only; recovery stays in the watchdog loop. RECOMMENDED.

Recommend B. Confirm with forge (owner-coordinator) which, since it decides whether the alert path
may carry recovery side-effects.

**RESOLVED (forge GO 2026-09-29): Option B.** Probe-only CLI, no recovery side-effect, read-only
alerting, fail-open on probe error, consecutiveDead>=2 bypass. **Refinement (dave):** build the CLI
from the EXISTING exported helpers (`resolveAgentProviderType` + `readAgentToken` +
`probeChannelPollerPresence` + `probeTelegramConflict`×`CONFLICT_PROBE_RETRIES` +
`reduceConflictProbes` + `assessPipeLiveness`) WITHOUT refactoring `runAgentCycle` -> the live
watchdog path is untouched (minimal blast radius; smaller c12 surface). Accept the ~15-line probe
orchestration duplication (add a comment cross-referencing runAgentCycle so both stay in sync); do
NOT extract a shared `probeAgentLiveness` now (that would touch the live path for marginal DRY).

## Implementation sketch (assuming B)
1. New CLI `src/web/per-agent-pipe-probe-cli.ts`: arg `<agent>`, run present+conflict probe once
   (reuse the probe helpers `runAgentCycle` uses, but stop at `assessPipeLiveness`), print
   `verdict=<...>`; exit 0 always. NO state write, NO recovery.
2. `pipe-watchdog-staleness-check.py`: for each STALE agent whose trigger was AGE-ONLY
   (`consecutiveDead < 2`), invoke the probe CLI; keep in `to_alert` ONLY if `verdict==dead`.
   `consecutiveDead >= 2` agents bypass re-probe (already live-confirmed). If the probe itself
   errors/times out -> FAIL-OPEN to alerting (don't suppress a real outage on probe failure) and
   note "(probe-inconclusive)" in the alert. LOG every suppressed false-STALE so a silenced alert
   is never invisible (silent-guard-audit discipline).
3. Keep `--dry-run` honoring: dry-run prints "would re-probe X" without shelling out (or with a
   `--no-probe` escape) so the n8n dry path stays side-effect-free.

## TDD (python + the pure TS verdict already covered)
- staleness-check unit: age-STALE agent + probe stub returns 'healthy' -> NOT alerted (the repro).
- age-STALE + probe 'dead' -> alerted.
- consecutiveDead>=2 -> alerted WITHOUT calling the probe (bypass).
- probe error/timeout -> FAIL-OPEN alert with "(probe-inconclusive)".
- value-carrying: assert the SUPPRESSED-alert log line is emitted (no silent suppression).
- assertion-direction: the dangerous side is SUPPRESSING A REAL OUTAGE — cover probe-error fail-open
  and the dead-verdict-still-alerts path, not just the happy false-positive suppression.

## Risk / rollback
Fleet-alerting only (no session-kill). Worst case of a bug = a missed real alert -> the fail-open on
probe error + the consecutiveDead>=2 bypass bound that. c12-Buster before touching the live cron.
Rollback = revert the python guard (pure-additive) + drop the new CLI.
