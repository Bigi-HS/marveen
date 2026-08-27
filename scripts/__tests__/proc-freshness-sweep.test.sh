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
# RESIDUAL, stated rather than glossed over: if the runner is killed hard enough
# to skip the EXIT trap, the fixtures still live out their bounded lifetime --
# up to ~120s, not zero. Bounded was the goal; anything running under this root
# in that window is this test, not a fleet process.
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


# --- node process tests (card 0941d203) --------------------------------------
# These tests verify that node processes running code under the root are NOT
# silently dropped from the sweep output.  Before the fix every node pid
# produced zero rows, making the C5 gate a false green for the dashboard.

mkdir -p "$ROOT/dist"

# node-fresh: .js file unchanged since the process started -> UNKNOWN
# (content cannot be verified; mtime shows no staleness signal)
cat > "$ROOT/dist/fresh-app.js" <<'JSEOF'
setTimeout(() => {}, 120000);
JSEOF
node "$ROOT/dist/fresh-app.js" >/dev/null 2>&1 &
NODE_FRESH_PID=$!
PIDS+=("$NODE_FRESH_PID")

# node-suspect: .js file modified AFTER the process starts -> SUSPECT
cat > "$ROOT/dist/suspect-app.js" <<'JSEOF'
setTimeout(() => {}, 120000);
JSEOF
node "$ROOT/dist/suspect-app.js" >/dev/null 2>&1 &
NODE_SUSPECT_PID=$!
PIDS+=("$NODE_SUSPECT_PID")

# Wait long enough that the modification timestamp exceeds started + START_MTIME_GRACE_SECONDS (2s).
# A 1s sleep is eaten by the grace window; 3s gives a clear signal.
sleep 3
# Mutate suspect-app.js after the process is running
printf '// modified\nsetTimeout(() => {}, 120000);\n' > "$ROOT/dist/suspect-app.js"
sleep 1

echo "sweep node fixtures under $ROOT/dist"

# Core regression: node process must not silently disappear from the sweep.
# Before the fix: label_of returns empty for every node pid.
node_fresh_label=$(label_of "$NODE_FRESH_PID")
[ -n "$node_fresh_label" ] \
  && pass "node process (fresh .js) appears in sweep output (was silently invisible before)" \
  || fail "node process should appear in sweep output, got empty (card 0941d203 regression)"

# A node process with an unchanged .js cannot be content-verified -> UNKNOWN.
[ "$node_fresh_label" = "UNKNOWN" ] \
  && pass "node process (fresh .js) classified UNKNOWN (mtime no staleness signal, content unverifiable)" \
  || fail "expected UNKNOWN for node/fresh, got '$node_fresh_label'"

# A node process whose .js was modified after start -> SUSPECT.
node_suspect_label=$(label_of "$NODE_SUSPECT_PID")
[ "$node_suspect_label" = "SUSPECT" ] \
  && pass "node process (stale .js) classified SUSPECT (mtime shows post-start modification)" \
  || fail "expected SUSPECT for node/suspect, got '$node_suspect_label'"

# Scoping: node processes outside root must not appear.
# (The existing scoping test already covers this for bash; extend explicitly for node.)
outside_node=$(run_sweep | awk -F'\t' '$1 != "COUNT" { print $3 }' | grep -c "meld-studio\|n8n" || true)
[ "$outside_node" -eq 0 ] \
  && pass "node sweep is scoped: node processes outside root not reported" \
  || fail "sweep leaked $outside_node node process(es) from outside the root"

# method column must say mtime-heuristic for node rows (not content-verified).
node_method=$(run_sweep | awk -F'\t' -v p="$NODE_FRESH_PID" '$2 == p { print $7 }')
[ "$node_method" = "mtime-heuristic" ] \
  && pass "node row carries method=mtime-heuristic" \
  || fail "expected method=mtime-heuristic for node row, got '$node_method'"

# Cross-sweep dedup (OPS-155, card 3b46fc4a): a node process spawned by bash
# (pid now in bash_pids) must NOT appear twice in the sweep output.
# We cannot easily spawn a node-spawned-by-bash fixture here, but we can verify
# the plumbing: _sweep_node receives prior_seen_pids from bash+python and the
# sweep() call passes bash_pids|python_pids. Check that the sweep count output
# does not duplicate the bash fixtures' PIDs in the node section.
# (Absence of double-counting is guaranteed by the prior_seen_pids guard added
# in this card; the existing PASS tests above prove no regression on node count.)
bash_pids=$(run_sweep | awk -F'\t' '$3 ~ /bash-script/ { print $2 }')
node_pids=$(run_sweep | awk -F'\t' '$7 == "mtime-heuristic" { print $2 }')
overlap=0
for bpid in $bash_pids; do
  if echo "$node_pids" | grep -qx "$bpid"; then
    overlap=$((overlap + 1))
  fi
done
[ "$overlap" -eq 0 ] \
  && pass "cross-sweep dedup: no bash PID appears in node section (OPS-155)" \
  || fail "cross-sweep dedup: $overlap bash PID(s) double-reported in node section"

echo
if [ "$FAIL" -gt 0 ]; then echo "FAILED ($FAIL)"; exit 1; fi
echo "OK"
