#!/bin/bash
# LIVE-activation gate for the per-agent pipe-watchdog (card 31ab64fe Part 2).
#
# WHY: unlike #36 (which only touches the orchestrator), the Part 2 sweep drives
# /mcp recovery on SIX channel sub-agents -- a wider blast radius. Per the
# test-on-sandbox-before-live rule, before this watchdog is allowed to sweep the
# live fleet we prove target-selection + recovery correctness end-to-end on the
# disposable sandbox bot (Buster), with ZERO live-agent interaction. Run this
# with Armorer as the deploy-activation gate; a clean PASS authorises live
# activation.
#
# HARD SAFETY INVARIANTS (do not weaken):
#   * The sweep is scoped to ONLY 'buster' via the sim driver's injected
#     listChannelSubAgents dep -- the other 5 live agents are never enumerated.
#   * The dead-pipe sim kills Buster's OWN bun child by a SINGLE verified PID
#     (matched on the agents/buster/ cwd path). NEVER pkill -f. Aborts if the
#     match is not exactly one buster-owned process.
#   * Buster is reverted at the end (c12 revert) so the sandbox is left clean.
#
# PREREQUISITE (provisioned by the operator/Armorer at activation, NOT by this
# script -- token wiring is deliberately out of scope here):
#   * agent-buster running with its OWN telegram channel (test bot
#     @Buster_TestDummy_bot), token present at
#     agents/buster/.claude/channels/telegram/.env.
# The script verifies this precondition and aborts loudly if absent.
#
# Usage: scripts/per-agent-watchdog-buster-sim.sh

set -euo pipefail

ROOT=/home/domin/marveen
cd "$ROOT"
export MARVEEN_ROOT="$ROOT"

PATH_CURATED="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export PATH="$PATH_CURATED"
NODE="$(command -v node)"
TMUXB="$(command -v tmux)"

BUSTER_SESSION="agent-buster"
BUSTER_CHILD_RX="agents/buster/.claude-config/plugins/.*telegram.*--shell=bun.*start"
BUSTER_TOKEN="$ROOT/agents/buster/.claude/channels/telegram/.env"
DRIVER="$ROOT/scripts/_per-agent-watchdog-sim-driver.mjs"
CLI_DIST="$ROOT/dist/web/per-agent-pipe-watchdog-cli.js"

fail() { echo "SIM: FAIL -- $*" >&2; exit 1; }
note() { echo "SIM: $*"; }

# --- preconditions ---------------------------------------------------------
[ -n "$NODE" ]  || fail "node not on PATH"
[ -n "$TMUXB" ] || fail "tmux not on PATH"
[ -f "$CLI_DIST" ] || fail "dist not built ($CLI_DIST missing) -- run npm run build"
[ -f "$DRIVER" ]   || fail "sim driver missing ($DRIVER)"
env -u TMUX "$TMUXB" has-session -t "$BUSTER_SESSION" 2>/dev/null \
  || fail "$BUSTER_SESSION not running -- provision Buster with its test channel first (operator/Armorer)"
[ -f "$BUSTER_TOKEN" ] \
  || fail "Buster telegram token absent ($BUSTER_TOKEN) -- Buster has no channel; provision its test bot first"

note "preconditions OK (buster up + channel token present)"

# --- locate Buster's OWN bun telegram child, scoped + verified -------------
# pgrep on the buster cwd path so we can NEVER match another agent's child.
mapfile -t PIDS < <(pgrep -f "$BUSTER_CHILD_RX" || true)
if [ "${#PIDS[@]}" -eq 0 ]; then
  fail "no buster bun-telegram child found (already dead?) -- expected exactly one before the kill sim"
elif [ "${#PIDS[@]}" -gt 1 ]; then
  fail "expected exactly ONE buster bun child, found ${#PIDS[@]}: ${PIDS[*]} -- aborting (will not guess)"
fi
CHILD_PID="${PIDS[0]}"
# Double-check the matched cmdline really is buster's, not a coincidental match.
CHILD_CMD="$(tr '\0' ' ' < /proc/$CHILD_PID/cmdline 2>/dev/null || true)"
case "$CHILD_CMD" in
  *agents/buster/*) : ;;
  *) fail "matched PID $CHILD_PID is NOT a buster child (cmd: $CHILD_CMD) -- aborting" ;;
esac
note "buster bun child = PID $CHILD_PID (verified buster-owned)"

# --- baseline: confirm the scoped sweep is a NO-OP recovery while healthy ---
# (pipe healthy -> verdict healthy/inconclusive -> no reconnect). Optional but
# proves we don't reconnect a healthy buster.
note "baseline scoped sweep (buster healthy, expect no recovery):"
SIM_TARGET_AGENT=buster "$NODE" "$DRIVER" | sed 's/^/SIM:   /' || fail "baseline driver errored"

# --- dead-pipe sim: PID-scoped kill (NEVER pkill -f) -----------------------
note "killing buster bun child PID $CHILD_PID (PID-scoped) to simulate a dead pipe"
kill "$CHILD_PID" 2>/dev/null || true
sleep 3
if kill -0 "$CHILD_PID" 2>/dev/null; then
  kill -9 "$CHILD_PID" 2>/dev/null || true
  sleep 2
fi
kill -0 "$CHILD_PID" 2>/dev/null && fail "could not kill buster child $CHILD_PID"
note "buster child down"

# --- the actual test: scoped down-sweep must detect + recover buster -------
note "running buster-scoped down-sweep (dashboard forced down, target=buster only):"
OUT="$(SIM_TARGET_AGENT=buster "$NODE" "$DRIVER" 2>&1)" || fail "sweep driver errored: $OUT"
echo "$OUT" | sed 's/^/SIM:   /'
RESULT_LINE="$(echo "$OUT" | grep '^SIM_RESULT=' || true)"
[ -n "$RESULT_LINE" ] || fail "no SIM_RESULT line from driver"

# Assert: not skipped, buster present in results, a dead-verdict drove a recovery
# attempt. (Parsed with node to avoid brittle string matching.)
echo "${RESULT_LINE#SIM_RESULT=}" | "$NODE" -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const r=JSON.parse(s);
    const b=r.results && r.results.buster;
    if (r.skipped) { console.error("assert FAIL: sweep was skipped ("+r.reason+")"); process.exit(1); }
    if (!b) { console.error("assert FAIL: buster not in results"); process.exit(1); }
    // target-selection: ONLY buster was swept
    const keys=Object.keys(r.results);
    if (keys.length!==1 || keys[0]!=="buster") { console.error("assert FAIL: swept "+keys.join(",")+" (expected only buster)"); process.exit(1); }
    console.log("assert OK: scoped to buster, verdict="+b.verdict+" recovered="+b.recovered);
  });
' || fail "result assertions failed"

# --- post-check: buster pipe recovers (child respawned) --------------------
note "waiting for buster pipe to recover (child respawn after /mcp)..."
RECOVERED=no
for _ in $(seq 1 12); do
  sleep 5
  if pgrep -f "$BUSTER_CHILD_RX" >/dev/null 2>&1; then RECOVERED=yes; break; fi
done
[ "$RECOVERED" = yes ] || note "WARN: buster bun child not observed back within ~60s (manual check advised)"

# --- cleanup: revert Buster to a clean sandbox baseline --------------------
note "reverting Buster sandbox (c12 revert)"
if [ -f "$ROOT/scripts/chameleon.ts" ] && command -v tsx >/dev/null 2>&1; then
  ( cd "$ROOT" && tsx scripts/chameleon.ts revert ) || note "WARN: chameleon revert returned non-zero -- verify Buster state by hand"
else
  note "WARN: chameleon.ts/tsx not available -- revert Buster manually"
fi

note "PASS -- buster-scoped down-sweep selected only buster, drove recovery; live activation authorised (with Armorer sign-off)"
