#!/bin/bash
# Tests the C5a decision in scripts/deploy-preflight-unifier.sh: when is a stale
# process the known, triaged backlog (WARN) and when is it new staleness (FAIL)?
#
# Why this exists: the first version of the carve-out keyed on PROCESS START TIME
# alone. Staleness is a relation between a process and a FILE, so that check was
# blind to its own core failure class -- land a real change in a watchdog and the
# process that had run since 07-11 goes stale for a NEW reason, but its sweep
# line is byte-identical to a backlog line and the gate calls it "known" for the
# whole grace week. Thor (N7) and the Devil's Advocate (DA-22) found this
# independently; case 2 below is the one that used to pass.
#
# The detector is replaced with a fixture that prints controlled TSV rather than
# mocking /proc: the question here is how the GATE decides, not how the sweep
# measures, and the sweep has its own real-process test. This also exercises the
# gate's SCRIPT_DIR resolution, since it finds the fixture beside itself.
#
# Only C5a lines are asserted; the other checks read live state and are not the
# subject.
#
# Run: bash scripts/__tests__/preflight-carve-out.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
GATE="$INSTALL_DIR/scripts/deploy-preflight-unifier.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$GATE" "$WORK/" || { echo "  FAIL: cannot copy $GATE"; exit 1; }

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# Epochs either side of the gate's 2026-08-01 cutoff.
PRE_PROC=1783725734    # 2026-07-11, a backlog watchdog
PRE_FILE=1785400000    # 2026-07-30, last touched before the cutoff
POST=1785808000        # 2026-08-04, today

fixture() {             # fixture <started> <mtime>
  cat > "$WORK/proc-freshness-sweep.py" <<EOF
#!/usr/bin/env python3
print("STALE\tdave-watchdog-pid\tdave-watchdog.sh\trunning content differs from disk\t$1\t$2")
print("COUNT\t1\t0\t0\t5\t1")
EOF
}

verdict_of() {          # -> WARN | FAIL | (empty)
  bash "$WORK/deploy-preflight-unifier.sh" 2>&1 \
    | awk '/^  (WARN|FAIL)  C5a/ { print $1; exit }'
}

check() {               # check <want> <started> <mtime> <description>
  fixture "$2" "$3"
  got=$(verdict_of)
  if [ "$got" = "$1" ]; then pass "$4 -> $1"; else fail "$4 should be $1, got '${got:-none}'"; fi
}

echo "C5a carve-out decisions (cutoff 2026-08-01, gate: $GATE)"

check WARN "$PRE_PROC" "$PRE_FILE" \
  "old process, script untouched since before the cutoff = triaged backlog"

# The regression. Same long-lived process, but its script changed today: a real
# change was deployed and did not take effect. Start time alone cannot see this.
check FAIL "$PRE_PROC" "$POST" \
  "old process, script changed AFTER the cutoff = a new change landed inert"

check FAIL "$POST" "$PRE_FILE" \
  "process started after the cutoff = not part of the backlog"

# Unreadable timestamps must fail closed: absence of proof that something
# predates the cutoff is not proof that it does.
check FAIL "$PRE_PROC" "" \
  "file mtime unreadable = not forgiven"
check FAIL "" "$PRE_FILE" \
  "process start time unreadable = not forgiven"

# Field alignment, not policy. Tab is an IFS-whitespace character, so a naive
# `IFS=$'\t' read` collapses an empty field and shifts everything after it --
# here an empty "why" would make the gate read the mtime as the start time. With
# both timestamps pre-cutoff the correct parse is WARN; the shifted parse loses
# the mtime and fails closed, so this case tells the two apart.
cat > "$WORK/proc-freshness-sweep.py" <<EOF
#!/usr/bin/env python3
print("STALE\tdave-watchdog-pid\tdave-watchdog.sh\t\t$PRE_PROC\t$PRE_FILE")
print("COUNT\t1\t0\t0\t5\t1")
EOF
got=$(verdict_of)
if [ "$got" = "WARN" ]; then
  pass "an empty middle field does not shift the timestamp columns"
else
  fail "empty middle field should still parse as the backlog (WARN), got '${got:-none}'"
fi

# The supervisor is excluded from the carve-out entirely, on both labels. A
# branch switch during a deploy puts it in SUSPECT, which is precisely when
# waiving it would hide an inert supervisor change.
cat > "$WORK/proc-freshness-sweep.py" <<EOF
#!/usr/bin/env python3
print("SUSPECT\t32353\tfleet-supervisor.sh\tfile modified after process start; parsed version unverifiable\t$PRE_PROC\t$POST")
print("COUNT\t0\t0\t1\t5\t1")
EOF
if bash "$WORK/deploy-preflight-unifier.sh" 2>&1 | grep -q "^  FAIL  C5c supervisor"; then
  pass "SUSPECT fleet-supervisor -> FAIL (not buried in the bulk warning)"
else
  fail "SUSPECT fleet-supervisor should FAIL"
fi

echo
if [ "$FAIL" -gt 0 ]; then echo "FAILED ($FAIL)"; exit 1; fi
echo "OK"
