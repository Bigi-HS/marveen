#!/bin/bash
# Regression test: every backgrounded launcher in fleet-supervisor.sh must close
# the single-instance flock fd (9>&-) so the child cannot outlive the supervisor
# while still holding the lock.
#
# Why this exists (live incident 2026-08-04): ensure_n8n_kanban_bridge was the one
# launcher missing `9>&-`. The bridge inherited fd 9, survived the supervisor, and
# kept the flock held. The next supervisor start then aborted with "another
# fleet-supervisor is already running" -- so the fleet supervisor could not be
# restarted at all until the bridge was killed by hand. Twelve other launchers had
# the redirect; this one did not, and nothing caught the omission.
#
# A test pinned to that single line would not have prevented it, because the bug
# was an omission in a NEW launcher. So this test scans every backgrounded launch
# in the script and asserts the redirect is present on each -- it fails for the
# next launcher added without it, not just for the one already fixed.
#
# Run: bash scripts/__tests__/supervisor-flock-fd-hygiene.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SUP="$INSTALL_DIR/scripts/fleet-supervisor.sh"

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

echo "flock fd hygiene: $SUP"

[ -r "$SUP" ] || { echo "  FAIL: cannot read $SUP"; exit 1; }

# The lock fd number the supervisor uses for its flock (see the `exec 9>` setup).
LOCK_FD=9

# Candidate lines: a background launch that starts a long-running child. `nohup
# ...&` and `tmux new-session` both detach children that can outlive the
# supervisor.
#
# Backslash continuations must be joined FIRST. Several launchers put the command
# on one line and the `9>&-` redirect on the next, so scanning raw lines reports
# them as leaking when they do not. Each logical line keeps the line number it
# started on, so failures still point at the right place.
mapfile -t CANDIDATES < <(
  awk '
    { line = $0 }
    buf == "" { start = NR }
    { sub(/\\[ \t]*$/, " ", line); buf = buf line }
    /\\[ \t]*$/ { next }
    { print start ":" buf; buf = "" }
    END { if (buf != "") print start ":" buf }
  ' "$SUP" \
    | grep -E '^[0-9]+:[^#]*(nohup |new-session)' \
    | grep -vE '^[0-9]+:[[:space:]]*#'
)

if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  fail "no backgrounded launchers found -- the scan pattern is stale, fix this test"
fi

echo "  scanning ${#CANDIDATES[@]} launcher line(s)"

for entry in "${CANDIDATES[@]}"; do
  lineno="${entry%%:*}"
  body="${entry#*:}"

  # A launcher only leaks the lock if it actually backgrounds or detaches a child.
  # `run ...` wrappers and DRY-RUN log lines do not.
  case "$body" in
    *"DRY-RUN"*) continue ;;
  esac
  if [[ "$body" != *"&"* ]] && [[ "$body" != *"new-session"* ]]; then
    continue
  fi

  if [[ "$body" == *"${LOCK_FD}>&-"* ]]; then
    pass "line $lineno closes fd $LOCK_FD"
  else
    fail "line $lineno backgrounds a child WITHOUT ${LOCK_FD}>&- -- it would inherit the supervisor flock and block the next supervisor start: ${body#"${body%%[![:space:]]*}"}"
  fi
done

# Explicit guard for the launcher that actually broke, so a future refactor that
# drops the redirect names this incident directly rather than a bare line number.
if grep -qE 'nohup python3 "\$bridge".*9>&-' "$SUP"; then
  pass "ensure_n8n_kanban_bridge closes fd $LOCK_FD (the 2026-08-04 regression)"
else
  fail "ensure_n8n_kanban_bridge does NOT close fd $LOCK_FD -- this is the exact 2026-08-04 supervisor-restart deadlock"
fi

echo
if [ "$FAIL" -gt 0 ]; then
  echo "FAILED ($FAIL)"
  exit 1
fi
echo "OK"
