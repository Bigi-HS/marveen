#!/bin/bash
# Tests the layout gate in scripts/rollback.sh: which backup directories may be
# restored, and -- more importantly -- that the ones that must not be refuse
# BEFORE anything touches dist/.
#
# Why this exists: rollback.sh restores with `rsync -a --delete "$BACKUP_DIR/"
# "$REPO/dist/"`, which assumes a flat backup. Of the 44 timestamped backups on
# this host, 17 are flat, 22 nest the dist one level down, and 5 are something
# else -- including one that is completely EMPTY and is still eligible for the
# auto-pick glob. Restoring from any of those deletes the running build. It is
# the break-glass tool, so it gets used under pressure and trusted by default
# (card OPS-098, devil-advocate DA-13).
#
# The assertions check both the verdict AND that the fixture dist is still intact
# afterwards -- a gate that returns the right exit code after already running the
# rsync would pass a verdict-only test.
#
# THE HAPPY PATH IS NOW COVERED (case 15), and the history of that sentence is
# worth keeping. This header used to say the happy path was deliberately not
# exercised "because a successful restore kills and recreates the live server
# session". That was true, and it was a trap: the script took ROLLBACK_REPO and
# ROLLBACK_BACKUP_ROOT but still hardcoded the `marveen` session and
# http://localhost:3420, so the isolation the header advertised did not exist and
# any author who accepted the invitation to cover the happy path would have taken
# production down. Dave proved it live on 2026-08-04 04:56:52. The fix was to
# parameterise the session and dashboard too; case 15 then became both safe and
# valuable, since restore+restart+verify is the only part of a break-glass tool
# that actually runs during an incident.
#
# One piece is still unreachable from here rather than untested: the post-restore
# `dist/index.js` assertion. The layout gate above it has already proved the source
# contains index.js, and `set -e` catches a non-zero rsync, so no input through the
# public interface can reach that assertion with it failing. Defence in depth
# against a future edit that weakens the gate, not a gap in coverage.
#
# Several assertions below check the MESSAGE, not just the exit code, on purpose.
# The blocker Dave found on PR#464 (case 9) exited 2 both before and after the fix
# -- before, because `set -e` killed the script at an assignment; after, because
# the error branch finally runs. An exit-code-only test would have stayed green
# straight through a break-glass tool that printed nothing at all.
#
# Run: bash scripts/__tests__/rollback-layout-gate.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RB="$INSTALL_DIR/scripts/rollback.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# A stand-in for the live repo. If the gate ever lets a bad restore through, the
# canary file below disappears and the assertion says so.
REPO="$WORK/repo"; mkdir -p "$REPO/dist" "$REPO/store" "$REPO/scripts"
echo "LIVE BUILD" > "$REPO/dist/index.js"
echo "asset"      > "$REPO/dist/canary.js"

BR="$WORK/backups"; mkdir -p "$BR"
mk() { mkdir -p "$BR/$1"; }
SHA=aaaaaaaabbbbbbbbccccccccddddddddeeeeeeee

mk 20260601-000000; echo "OLD BUILD" > "$BR/20260601-000000/index.js"          # flat, unlabelled
mk 20260602-000000; echo "OLD BUILD" > "$BR/20260602-000000/index.js"
                    echo "$SHA"      > "$BR/20260602-000000/deployed-sha.txt"  # flat, labelled
mk 20260603-000000/dist; echo "OLD BUILD" > "$BR/20260603-000000/dist/index.js"  # nested
mk 20260604-000000                                                             # EMPTY
mk 20260605-000000/dist-prev; echo x > "$BR/20260605-000000/dist-prev/index.js" # unrecognised

run() { ROLLBACK_REPO="$REPO" ROLLBACK_BACKUP_ROOT="$BR" bash "$RB" "$@" 2>&1; }

dist_intact() {
  [[ -f "$REPO/dist/index.js" && -f "$REPO/dist/canary.js" \
     && "$(cat "$REPO/dist/index.js")" == "LIVE BUILD" ]]
}

echo "rollback.sh layout gate"

# --- 1. nested: the 22-dir case. Refuse, and name the inner path that works.
out=$(run "$BR/20260603-000000"); rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q "20260603-000000/dist$" && dist_intact; then
  pass "nested backup -> refused, live dist untouched, inner path named"
else
  fail "nested should refuse and leave dist alone (rc=$rc, intact=$(dist_intact && echo y || echo n)): $out"
fi

# --- 2. empty: the silent killer, and the one the original report missed.
out=$(run "$BR/20260604-000000"); rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q "EMPTY" && dist_intact; then
  pass "empty backup -> refused, live dist untouched"
else
  fail "empty should refuse (rc=$rc): $out"
fi

# --- 3. unrecognised layout: guessing which subdir is the dist deletes the build.
out=$(run "$BR/20260605-000000"); rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q "dist-prev" && dist_intact; then
  pass "unrecognised layout -> refused, contents listed, live dist untouched"
else
  fail "unrecognised layout should refuse (rc=$rc): $out"
fi

# --- 4. auto-pick must be gated too. Without an argument the glob picks the
#        newest dir, which here is the unrecognised one -- the realistic incident
#        shape, since nobody types a path while the fleet is down.
out=$(run); rc=$?
if [[ $rc -eq 2 ]] && dist_intact; then
  pass "auto-picked bad backup -> refused, live dist untouched"
else
  fail "auto-pick should be gated the same way (rc=$rc): $out"
fi

# --- 5. flat but unlabelled: restorable, but it leaves deployed-tip naming the
#        build being replaced, so it needs an explicit acknowledgement.
out=$(run --check "$BR/20260601-000000"); rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q "unlabelled"; then
  pass "flat but unlabelled -> refused until acknowledged"
else
  fail "unlabelled should require --unlabelled (rc=$rc): $out"
fi
out=$(run --check --unlabelled "$BR/20260601-000000"); rc=$?
[[ $rc -eq 0 ]] \
  && pass "--unlabelled acknowledges it and proceeds" \
  || fail "--unlabelled should proceed (rc=$rc): $out"

# --- 6. flat and labelled: the only shape that passes unannotated.
out=$(run --check "$BR/20260602-000000"); rc=$?
if [[ $rc -eq 0 ]] && echo "$out" | grep -q "${SHA:0:8}"; then
  pass "flat + labelled -> usable, build named"
else
  fail "flat labelled should be usable (rc=$rc): $out"
fi

# --- 7. the audit has to mark every class, not just count them.
out=$(run --audit)
if echo "$out" | grep -q "DANGEROUS.*20260604-000000" \
   && echo "$out" | grep -q "NOT USABLE.*20260603-000000" \
   && echo "$out" | grep -q "USABLE     20260602-000000"; then
  pass "--audit marks usable, not-usable and dangerous separately"
else
  fail "--audit output incomplete: $out"
fi

# --- 8. the hazard itself, demonstrated rather than asserted. This is the exact
#        command the pre-fix script ran (see the diff); running it against a
#        throwaway repo shows what "not usable" costs -- the live build is gone
#        and dist/dist/ is left behind. Kept in the suite so nobody later relaxes
#        the gate on the theory that a nested restore is merely untidy.
VICTIM="$WORK/victim"; mkdir -p "$VICTIM/dist"
echo "LIVE BUILD" > "$VICTIM/dist/index.js"; echo asset > "$VICTIM/dist/canary.js"
rsync -a --delete "$BR/20260603-000000/" "$VICTIM/dist/"
if [[ ! -f "$VICTIM/dist/index.js" && -f "$VICTIM/dist/dist/index.js" ]]; then
  pass "unguarded nested restore destroys the live build and leaves dist/dist/ (the defect)"
else
  fail "expected the unguarded restore to destroy dist/: $(find "$VICTIM/dist" -type f)"
fi

# --- 9. no backup at all. THE case that must speak: under `set -euo pipefail` the
#        `ls` inside all_backups exits 2 on an empty root, pipefail promotes it and
#        set -e killed the script at the assignment -- before the documented error
#        branch could print. rc was 2 either way, so assert the MESSAGE. (Dave,
#        PR#464 review; measured pre-fix as rc=2 with zero bytes of output.)
EMPTY_ROOT="$WORK/emptyroot"; mkdir -p "$EMPTY_ROOT"
out=$(ROLLBACK_REPO="$REPO" ROLLBACK_BACKUP_ROOT="$EMPTY_ROOT" bash "$RB" 2>&1); rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q "no valid backup dir found" && dist_intact; then
  pass "empty backup root -> refuses AND says why (not a silent death)"
else
  fail "empty root must print 'no valid backup dir found' (rc=$rc, out=[$out])"
fi

# --- 10. same shape, one step worse: the root does not exist at all.
out=$(ROLLBACK_REPO="$REPO" ROLLBACK_BACKUP_ROOT="$WORK/does-not-exist" bash "$RB" 2>&1); rc=$?
if [[ $rc -eq 2 ]] && echo "$out" | grep -q "no valid backup dir found"; then
  pass "missing backup root -> refuses AND says why"
else
  fail "missing root must print the error (rc=$rc, out=[$out])"
fi

# --- 11. an unreadable dir must not be diagnosed as EMPTY: `ls -A` failing and
#         succeeding-with-no-output look identical, but one is fixed with chmod and
#         the other by choosing a different backup.
mk 20260606-000000; echo "OLD BUILD" > "$BR/20260606-000000/index.js"
chmod 000 "$BR/20260606-000000"
out=$(run "$BR/20260606-000000"); rc=$?
chmod 755 "$BR/20260606-000000"
if [[ $rc -eq 2 ]] && echo "$out" | grep -qi "permissions" && ! echo "$out" | grep -q "EMPTY" && dist_intact; then
  pass "unreadable backup -> refused as unreadable, not misreported as empty"
else
  fail "unreadable should be distinguished from empty (rc=$rc): $out"
fi

# --- 12. --audit was only recognised as argv[1], so '--check --audit' died with
#         "unknown option" -- a flag that works only in one position is a trap in a
#         tool used under pressure.
out=$(run --check --audit); rc=$?
if [[ $rc -eq 0 ]] && ! echo "$out" | grep -q "unknown option"; then
  pass "--audit is position-independent among the flags"
else
  fail "--audit should parse in any flag position (rc=$rc): $out"
fi

# --- 13. the audit must not be quieter than the gate. "0 usable, 0 not usable"
#         over a root with nothing in it reads as a clean bill of health for a
#         host that has no rollback point at all. (Thor, PR#464 review item 3.)
out=$(ROLLBACK_REPO="$REPO" ROLLBACK_BACKUP_ROOT="$EMPTY_ROOT" bash "$RB" --audit 2>&1); rc=$?
if [[ $rc -eq 0 ]] && echo "$out" | grep -q "NO rollback point"; then
  pass "--audit on an empty root says there is no rollback point"
else
  fail "--audit must not report an empty root as a clean result (rc=$rc): $out"
fi
out=$(ROLLBACK_REPO="$REPO" ROLLBACK_BACKUP_ROOT="$WORK/does-not-exist" bash "$RB" --audit 2>&1); rc=$?
if [[ $rc -eq 0 ]] && echo "$out" | grep -q "does not exist"; then
  pass "--audit on a missing root names the missing directory"
else
  fail "--audit on a missing root must say so (rc=$rc): $out"
fi

# --- 15. THE HAPPY PATH, fully enclosed. Until now this was the only part of the
#         break-glass tool nothing covered, and the reason was that the restart
#         block hardcoded `marveen` and http://localhost:3420 -- so a fixture-
#         directed run killed the real dashboard. Dave demonstrated exactly that
#         live on 2026-08-04 04:56:52. With ROLLBACK_SESSION/ROLLBACK_DASHBOARD the
#         run is enclosed and the restore+restart+verify path is finally testable.
#
#         The last assertion is the one that would have caught the incident: the
#         live marveen session must be exactly as it was, same creation timestamp.
#         SELF-GUARD, and it is not optional. This case is the one part of the
#         suite that is destructive when pointed at a revision WITHOUT the
#         ROLLBACK_SESSION/ROLLBACK_DASHBOARD support -- against such a script it
#         does exactly what it is testing against: kills the live dashboard. That
#         matters because running this suite against the OLD script is our standard
#         counter-test, the thing Thor and I both do to prove the cases
#         discriminate. So detect the capability instead of assuming it, and skip
#         loudly. Never make the counter-test the dangerous operation.
if ! grep -q 'ROLLBACK_SESSION' "$RB"; then
  echo "  SKIP: happy path -- $RB has no ROLLBACK_SESSION support, so running it"
  echo "        would target the LIVE session. This is the expected result when"
  echo "        counter-testing against a pre-fix revision; it is not a pass."
else
LIVE_BEFORE=$(tmux display-message -t marveen -p '#{session_created}' 2>/dev/null || echo "absent")

HREPO="$WORK/hrepo"; mkdir -p "$HREPO/dist" "$HREPO/store" "$HREPO/scripts"
echo "LIVE BUILD"  > "$HREPO/dist/index.js"
echo "stale asset" > "$HREPO/dist/gone.js"      # must be removed by --delete
echo "tok"         > "$HREPO/store/.dashboard-token"
echo "OLDTIP"      > "$HREPO/store/.deployed-tip"
cat > "$HREPO/scripts/update-deployed-tip.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$1" > "$(cd "$(dirname "$0")/.." && pwd)/store/.deployed-tip"
STUB

HBR="$WORK/hbackups"; mkdir -p "$HBR/20260701-000000"
echo "RESTORED BUILD" > "$HBR/20260701-000000/index.js"
echo "$SHA"           > "$HBR/20260701-000000/deployed-sha.txt"

# Stub dashboard: health 200, and a passing gate/verify.
PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")
python3 - "$PORT" <<'PY' &
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"pass": true}' if 'verify' in self.path else b'{"ok": true}'
        self.send_response(200); self.send_header('Content-Type','application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
STUB_PID=$!
TEST_SESSION="rollback-selftest-$$"
for _ in $(seq 1 25); do
  curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/api/health" && break
  sleep 0.2
done

out=$(ROLLBACK_REPO="$HREPO" ROLLBACK_BACKUP_ROOT="$HBR" \
      ROLLBACK_SESSION="$TEST_SESSION" ROLLBACK_DASHBOARD="http://127.0.0.1:$PORT" \
      bash "$RB" 2>&1); rc=$?

kill "$STUB_PID" 2>/dev/null
tmux kill-session -t "$TEST_SESSION" 2>/dev/null

LIVE_AFTER=$(tmux display-message -t marveen -p '#{session_created}' 2>/dev/null || echo "absent")

if [[ $rc -eq 0 ]] \
   && [[ "$(cat "$HREPO/dist/index.js")" == "RESTORED BUILD" ]] \
   && [[ ! -f "$HREPO/dist/gone.js" ]] \
   && [[ "$(cat "$HREPO/store/.deployed-tip")" == "$SHA" ]] \
   && [[ ! -f "$HREPO/store/planned-restart.marker" ]]; then
  pass "happy path: restore + restart + verify completes and relabels deployed-tip"
else
  fail "happy path (rc=$rc, index=$(cat "$HREPO/dist/index.js" 2>/dev/null), tip=$(cat "$HREPO/store/.deployed-tip" 2>/dev/null)): $out"
fi

if [[ "$LIVE_BEFORE" == "$LIVE_AFTER" ]]; then
  pass "the live marveen session was NOT touched by a fixture-directed run"
else
  fail "A FIXTURE RUN DISTURBED THE LIVE SESSION: before=$LIVE_BEFORE after=$LIVE_AFTER"
fi
fi

echo
if [[ "$FAIL" -gt 0 ]]; then echo "FAILED ($FAIL)"; exit 1; fi
echo "OK"
