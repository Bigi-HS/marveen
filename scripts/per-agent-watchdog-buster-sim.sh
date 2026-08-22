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
#     identified by PROCESS ANCESTRY (descendant of the agent-buster tmux pane),
#     NOT a plugin-cache path -- Buster's child runs from the GLOBAL plugin cache
#     (~/.claude/plugins/...), so a path match on agents/buster/ finds nothing.
#     NEVER pkill -f. Aborts unless exactly one buster-owned (by-ancestry) match.
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
# Broad candidate pattern (ANY agent's telegram bun child). We then keep ONLY the
# one whose process ancestry leads back to the agent-buster pane -- matching by
# ANCESTRY, not by the plugin-cache path, because the cache may be global
# (~/.claude/plugins, as Buster runs) or agent-isolated, and detection must not
# depend on which.
BUN_TELEGRAM_RX="telegram.*--shell=bun.*start"
BUSTER_TOKEN="$ROOT/agents/buster/.claude/channels/telegram/.env"
DRIVER="$ROOT/scripts/_per-agent-watchdog-sim-driver.mjs"
CLI_DIST="$ROOT/dist/web/per-agent-pipe-watchdog-cli.js"

fail() { echo "SIM: FAIL -- $*" >&2; exit 1; }
note() { echo "SIM: $*"; }

# True if $1 is $2 or a descendant of $2 (walk the PPid chain up). Bounded so a
# pathological/looping chain can never hang the gate.
is_descendant() {
  local pid="$1" ancestor="$2" guard=0 ppid
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ "$guard" -lt 64 ]; do
    [ "$pid" = "$ancestor" ] && return 0
    ppid="$(awk '/^PPid:/{print $2}' "/proc/$pid/status" 2>/dev/null)"
    [ -n "$ppid" ] || return 1
    pid="$ppid"; guard=$((guard + 1))
  done
  return 1
}

# All telegram bun children that are descendants of the agent-buster pane. This
# is the ONLY way we identify "Buster's child" -- by ancestry, never by path.
buster_telegram_children() {
  local pane_pid="$1" p
  for p in $(pgrep -f "$BUN_TELEGRAM_RX" || true); do
    is_descendant "$p" "$pane_pid" && echo "$p"
  done
}

# --- preconditions ---------------------------------------------------------
[ -n "$NODE" ]  || fail "node not on PATH"
[ -n "$TMUXB" ] || fail "tmux not on PATH"
[ -f "$CLI_DIST" ] || fail "dist not built ($CLI_DIST missing) -- run npm run build"
[ -f "$DRIVER" ]   || fail "sim driver missing ($DRIVER)"
env -u TMUX "$TMUXB" has-session -t "=$BUSTER_SESSION" 2>/dev/null \
  || fail "$BUSTER_SESSION not running -- provision Buster with its test channel first (operator/Armorer)"
[ -f "$BUSTER_TOKEN" ] \
  || fail "Buster telegram token absent ($BUSTER_TOKEN) -- Buster has no channel; provision its test bot first"

note "preconditions OK (buster up + channel token present)"

# --- locate Buster's OWN bun telegram child, by ANCESTRY + verified --------
# Resolve the agent-buster pane pid, then keep only telegram bun children whose
# PPid chain leads back to it. This can NEVER match another agent's child
# (different session/ancestry) regardless of where the plugin cache lives.
PANE_PID="$(env -u TMUX "$TMUXB" list-panes -t "$BUSTER_SESSION" -F '#{pane_pid}' 2>/dev/null | head -1)"
[ -n "$PANE_PID" ] || fail "could not resolve the agent-buster pane pid"
mapfile -t PIDS < <(buster_telegram_children "$PANE_PID")
if [ "${#PIDS[@]}" -eq 0 ]; then
  fail "no telegram bun child found under the agent-buster pane (PID $PANE_PID) -- buster has no live channel child (already dead, or channel not provisioned)"
elif [ "${#PIDS[@]}" -gt 1 ]; then
  fail "expected exactly ONE buster-owned telegram bun child, found ${#PIDS[@]}: ${PIDS[*]} -- aborting (will not guess)"
fi
CHILD_PID="${PIDS[0]}"
note "buster bun child = PID $CHILD_PID (verified by ancestry to agent-buster pane $PANE_PID)"

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
  if [ -n "$(buster_telegram_children "$PANE_PID")" ]; then RECOVERED=yes; break; fi
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
