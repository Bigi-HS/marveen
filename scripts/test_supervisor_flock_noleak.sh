#!/bin/bash
# Tests for the single-instance flock fd-leak fix in scripts/fleet-supervisor.sh
# (card 09fa76f2).
#
# Mechanism: the supervisor holds an flock on fd 9 for its lifetime. When it
# launches the dashboard via `tmux new-session`, a tmux SERVER first started by
# that client inherits the client's open fds. If fd 9 is not closed (9>&-), the
# server -- and every pane it ever spawns, including the long-lived node
# dashboard -- inherits fd 9 and keeps the lock held. A later supervisor restart
# then fails "lock held" until the lock inode is rm'd.
#
# This harness reproduces the leak on an ISOLATED tmux socket (tmux -L, a throw-
# away server) so it never touches the live fleet, proves that 9>&- closes it,
# and asserts the real launch_dashboard carries the fix.
#
# Run: bash scripts/test_supervisor_flock_noleak.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPERVISOR="$ROOT/scripts/fleet-supervisor.sh"
TMUX_BIN="$(command -v tmux)"
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

if [ -z "$TMUX_BIN" ]; then
  echo "SKIP: tmux not on PATH -- cannot run the leak repro"
  exit 0
fi

TMP="$(mktemp -d)"
SOCK_LEAK="flocktest-leak-$$"
SOCK_FIX="flocktest-fix-$$"
cleanup() {
  "$TMUX_BIN" -L "$SOCK_LEAK" kill-server 2>/dev/null || true
  "$TMUX_BIN" -L "$SOCK_FIX"  kill-server 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# Real-world symptom: tmux sanitizes a PANE's fds, but the tmux SERVER first
# started by a client inherits that client's open fds. If the client holds the
# flock on fd 9 and does not close it, the server keeps fd 9 -> the lock stays
# HELD even after the original holder dies, so the next supervisor exits "lock
# held". We assert on lock acquirability after the holder exits -- the exact
# failure mode -- not on a pane's fd table.
#
# $1 = socket (own lock file), $2 = "leak" (no 9>&-) | "fix" (9>&-).
# Prints "HELD" (server kept the lock) | "FREE" (server started clean).
probe() {
  local sock="$1" mode="$2"
  local lock="$TMP/$sock.lock"
  (
    exec 9>"$lock"
    flock -n 9 || { echo "ERR-lock"; exit 1; }
    if [ "$mode" = "fix" ]; then
      "$TMUX_BIN" -L "$sock" new-session -d -s s "exec bash -c 'sleep 30'" 9>&-
    else
      "$TMUX_BIN" -L "$sock" new-session -d -s s "exec bash -c 'sleep 30'"
    fi
  )
  # The spawning subshell has exited, releasing ITS fd 9. Any remaining hold on
  # the lock is the tmux server's. Try to acquire from a fresh process.
  if flock -n "$lock" -c 'true' 2>/dev/null; then echo "FREE"; else echo "HELD"; fi
}

# 1. Without 9>&- the tmux server inherits fd 9 and keeps the lock held after
#    the holder dies -> the "lock held" leak this fix targets.
r="$(probe "$SOCK_LEAK" leak)"
[ "$r" = "HELD" ] && ok "repro: without 9>&- the tmux server keeps the flock held after the holder exits" \
                  || bad "repro: expected HELD (leak), got '$r'"

# 2. With 9>&- the server starts clean and the lock frees when the holder exits.
r="$(probe "$SOCK_FIX" fix)"
[ "$r" = "FREE" ] && ok "fix: with 9>&- the lock frees once the holder exits (no server leak)" \
                  || bad "fix: expected FREE, got '$r'"

# 3. Source-contract: the real launch_dashboard closes fd 9 on the tmux launch.
if grep -A3 'new-session -d -s "\$DASH_SESSION"' "$SUPERVISOR" | grep -q '9>&-'; then
  ok "contract: launch_dashboard's tmux new-session carries 9>&-"
else
  bad "contract: launch_dashboard's tmux new-session is missing 9>&-"
fi

# 4. Regression: every nohup-backgrounded launch still closes fd 9 (no site lost it).
missing="$(grep -nE 'nohup bash .*\.sh' "$SUPERVISOR" | grep -v '9>&-' || true)"
[ -z "$missing" ] && ok "contract: all nohup launch sites still carry 9>&-" \
                  || bad "contract: a nohup launch site lost 9>&-:
$missing"

echo
echo "flock-noleak: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
