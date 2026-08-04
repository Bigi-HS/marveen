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
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  rm -rf "$ROOT"
}
trap cleanup EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

spawn() {                       # spawn <path> -> echoes pid
  # stdout/stderr must be redirected away from the command substitution that
  # calls this: $( ) waits for the pipe to close, and a backgrounded child
  # inheriting stdout keeps it open, so the substitution would hang forever.
  bash "$1" >/dev/null 2>&1 &
  echo $!
}

run_sweep() { python3 "$SWEEP" "$ROOT"; }
label_of()  { run_sweep | awk -F'\t' -v p="$1" '$2 == p { print $1 }'; }
count_field() { run_sweep | awk -F'\t' '$1 == "COUNT" { print $'"$1"' }'; }

mkdir -p "$ROOT/scripts"
LOOP='while :; do sleep 300; done'

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
sup_seen=$(run_sweep | awk -F'\t' '$3 == "fleet-supervisor.sh"' | wc -l)
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

# Scoping: nothing outside the given root may be reported.
outside=$(run_sweep | awk -F'\t' '$1 != "COUNT"' | grep -c "watchdog" || true)
[ "$outside" -eq 0 ] \
  && pass "sweep is scoped to the given root only" \
  || fail "sweep leaked $outside process(es) from outside the root"

echo
if [ "$FAIL" -gt 0 ]; then echo "FAILED ($FAIL)"; exit 1; fi
echo "OK"
