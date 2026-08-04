#!/bin/bash
# Tests for scripts/proc-freshness-sweep.py, the detector behind the preflight
# gate's C5 check.
#
# Real processes, real deleted inodes, zero mocking. The sweep reads /proc, so a
# faked /proc would test the fake; instead this spawns actual sleeping bash
# scripts under a temp root and mutates their files the way git does.
#
# It exists because the first version of C5 used `pgrep ... | head -1` and would
# have waved through the exact defect it was written to catch: with two
# supervisors running, `head -1` inspects an arbitrary one, and a cmdline regex
# also matches the checking shell's own wrapper. Both were demonstrated live
# (thor, devil-advocate) before this rewrite.
#
# Run: bash scripts/__tests__/proc-freshness-sweep.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SWEEP="$INSTALL_DIR/scripts/proc-freshness-sweep.py"
ROOT="$(mktemp -d)"
PIDS=()

cleanup() {
  # Kill the fixture's own `sleep` child as well as the fixture shell. `kill $p`
  # alone leaves the sleep it is blocked in running as an orphan.
  #
  # Deliberately NOT a process-group kill: a non-interactive shell runs without
  # job control, so the fixtures share this test's process group and
  # `kill -- -PGID` would take the test runner -- and its caller -- down with
  # them. Explicit pids only.
  for p in "${PIDS[@]:-}"; do
    [ -n "$p" ] || continue
    for c in $(ps --ppid "$p" -o pid= 2>/dev/null); do kill "$c" 2>/dev/null; done
    kill "$p" 2>/dev/null
  done
  rm -rf "$ROOT"
}
trap cleanup EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

spawn() {                       # spawn <path> -> echoes pid
  # Both redirections matter, for the same reason: $( ) reads until the pipe
  # closes, and a backgrounded child that inherits stdout or stderr holds it
  # open, so the substitution never returns. That is not theoretical -- an
  # earlier iteration of this test wedged for 19 minutes on this host, its
  # fixtures were reparented past the EXIT trap, and the immortal loops then
  # appeared in the LIVE sweep as STALE findings. The test was polluting the
  # /proc space it inspects (thor N6, devil-advocate DA-14).
  #
  # No `timeout` or `setsid` wrapper: $! must be the pid of the bash executing
  # the script, because that is the process holding fd 255 and the one the sweep
  # reports. A wrapper would make $! the wrapper's pid and every assertion would
  # look up the wrong process. The lifetime bound lives in the fixture body
  # instead -- see LOOP.
  bash "$1" >/dev/null 2>&1 &
  echo $!
}

run_sweep() { python3 "$SWEEP" "$ROOT"; }
label_of()  { run_sweep | awk -F'\t' -v p="$1" '$2 == p { print $1 }'; }
count_field() { run_sweep | awk -F'\t' '$1 == "COUNT" { print $'"$1"' }'; }

mkdir -p "$ROOT/scripts"
# Self-limiting, and in short steps. `while :; do sleep 300; done` survives
# forever if the EXIT trap is ever skipped (kill -9, a wedge, a crashed runner),
# and a 300s sleep outlives its own parent by up to five minutes. This runs for
# ~2 minutes at most and never leaves an orphan alive for more than a second,
# so a mishandled run cannot leave immortal processes in the sweep's field of
# view.
LOOP='for _ in $(seq 1 120); do sleep 1; done'

# --- fixtures ---------------------------------------------------------------
# healthy: untouched after start
printf '#!/bin/bash\n# healthy\n%s\n' "$LOOP" > "$ROOT/scripts/healthy.sh"
# ghost: file REPLACED after start, exactly what a git checkout / merge does
printf '#!/bin/bash\n# ghost original\n%s\n' "$LOOP" > "$ROOT/scripts/ghost.sh"
# deleted: file removed entirely after start
printf '#!/bin/bash\n# deleted\n%s\n' "$LOOP" > "$ROOT/scripts/deleted.sh"
# supervisor duplicates: two processes, only the SECOND one goes stale, so a
# check that inspects a single arbitrary match reports a false green
printf '#!/bin/bash\n# supervisor\n%s\n' "$LOOP" > "$ROOT/scripts/fleet-supervisor.sh"

HEALTHY_PID=$(spawn "$ROOT/scripts/healthy.sh");        PIDS+=("$HEALTHY_PID")
GHOST_PID=$(spawn "$ROOT/scripts/ghost.sh");            PIDS+=("$GHOST_PID")
DELETED_PID=$(spawn "$ROOT/scripts/deleted.sh");        PIDS+=("$DELETED_PID")
SUP1_PID=$(spawn "$ROOT/scripts/fleet-supervisor.sh");  PIDS+=("$SUP1_PID")
SUP2_PID=$(spawn "$ROOT/scripts/fleet-supervisor.sh");  PIDS+=("$SUP2_PID")
sleep 1

# mutate AFTER the processes are up
rm -f "$ROOT/scripts/ghost.sh"
printf '#!/bin/bash\n# ghost REPLACED\n%s\n' "$LOOP" > "$ROOT/scripts/ghost.sh"
rm -f "$ROOT/scripts/deleted.sh"
sleep 1

echo "sweep fixtures under $ROOT"

# --- assertions -------------------------------------------------------------
[ "$(label_of "$GHOST_PID")" = "STALE" ] \
  && pass "replaced script -> STALE" \
  || fail "replaced script should be STALE, got '$(label_of "$GHOST_PID")'"

[ "$(label_of "$DELETED_PID")" = "STALE" ] \
  && pass "removed script -> STALE" \
  || fail "removed script should be STALE, got '$(label_of "$DELETED_PID")'"

[ -z "$(label_of "$HEALTHY_PID")" ] \
  && pass "untouched script -> fresh (not reported)" \
  || fail "untouched script should be fresh, got '$(label_of "$HEALTHY_PID")'"

# The core regression: BOTH supervisors must be seen. `head -1` would inspect one.
sup_count=$(count_field 6)
[ "$sup_count" -eq 2 ] \
  && pass "both fleet-supervisor processes counted (no head -1 truncation)" \
  || fail "expected 2 supervisors counted, got '$sup_count'"

# Content-identical replacement must NOT be reported stale: a git checkout that
# restores identical bytes mints a new inode, and an inode-based check false-FAILs.
printf '#!/bin/bash\n# healthy\n%s\n' "$LOOP" > "$ROOT/scripts/healthy.sh.tmp"
mv "$ROOT/scripts/healthy.sh.tmp" "$ROOT/scripts/healthy.sh"
sleep 1
lbl=$(label_of "$HEALTHY_PID")
[ "$lbl" = "SUSPECT" ] || [ -z "$lbl" ] \
  && pass "byte-identical replacement -> not STALE (inode churn does not fake a failure)" \
  || fail "byte-identical replacement should not be STALE, got '$lbl'"

# A stale process anywhere must show up in the STALE count, not be masked.
stale_count=$(count_field 2)
[ "$stale_count" -ge 2 ] \
  && pass "stale count reports every offender ($stale_count)" \
  || fail "expected >=2 stale, got '$stale_count'"

# The start-time column is what lets the gate tell a pre-existing stale backlog
# apart from staleness that appeared after a cutoff. If it were empty the gate
# would treat every offender as new and block on the known backlog, so assert it
# is a plausible epoch rather than merely present.
start_col=$(run_sweep | awk -F'\t' -v p="$GHOST_PID" '$2 == p { print $5 }')
now=$(date +%s)
if [ -n "$start_col" ] && [ "$start_col" -gt $((now - 600)) ] && [ "$start_col" -le "$now" ]; then
  pass "stale record carries the process start time (epoch $start_col)"
else
  fail "stale record should carry a recent start epoch, got '$start_col'"
fi

# Scoping: nothing outside the given root may be reported.
outside=$(run_sweep | awk -F'\t' '$1 != "COUNT"' | grep -c "watchdog" || true)
[ "$outside" -eq 0 ] \
  && pass "sweep is scoped to the given root only" \
  || fail "sweep leaked $outside process(es) from outside the root"

echo
if [ "$FAIL" -gt 0 ]; then echo "FAILED ($FAIL)"; exit 1; fi
echo "OK"
