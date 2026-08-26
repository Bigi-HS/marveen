#!/usr/bin/env bash
# Regression guard for the OPS-137 dashboard kill-loop (2026-08-26).
#
# dash_alive() in fleet-supervisor.sh probes :3420/api/health and treats a
# curl timeout (code 000) as DOWN -> the supervisor then kills+relaunches the
# dashboard. If the probe timeout is SHORTER than the worst-case event-loop
# starvation spike (sync tmux capture flood can push /api/health latency past
# 10s while the server is still ALIVE), the supervisor kills a healthy-but-slow
# server and the fresh process is still starved -> self-sustaining restart
# kill-loop. The timeout MUST stay generous (>= 15s) so a starvation spike is
# tolerated, not misread as a crash. The async/throttle capture root-fix removes
# the starvation itself; this floor keeps the amplifier disarmed.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPERVISOR="$ROOT/scripts/fleet-supervisor.sh"
MIN_TIMEOUT=15

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f "$SUPERVISOR" ] || fail "supervisor script not found at $SUPERVISOR"

# Extract the -m <N> timeout from the dash_alive() /api/health probe line.
probe_line="$(grep -nE '/api/health' "$SUPERVISOR" | grep -E '\-m [0-9]+' | head -1)"
[ -n "$probe_line" ] || fail "could not locate the dash_alive /api/health probe line"

timeout_val="$(printf '%s\n' "$probe_line" | grep -oE '\-m [0-9]+' | grep -oE '[0-9]+' | head -1)"
[ -n "$timeout_val" ] || fail "could not parse -m timeout from: $probe_line"

if [ "$timeout_val" -lt "$MIN_TIMEOUT" ]; then
  fail "dash_alive probe timeout is ${timeout_val}s (< ${MIN_TIMEOUT}s floor) -- an OPS-137 starvation spike would be misread as DOWN and re-arm the kill-loop"
fi

echo "PASS: dash_alive probe timeout = ${timeout_val}s (>= ${MIN_TIMEOUT}s floor)"
