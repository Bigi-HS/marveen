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
# Sessions this suite creates, so an abort between new-session and kill-session
# does not strand a `rollback-selftest-<pid>` on the live tmux server. The old
# trap only removed $WORK. (Thor, R3.)
TEST_SESSIONS=""
cleanup() {
  local s
  for s in $TEST_SESSIONS; do env -u TMUX tmux kill-session -t "=$s" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

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

# ---------------------------------------------------------------------------
# Machinery for the three live-session cases. All of it exists because of one
# night, so the reasons are written down rather than assumed.
# ---------------------------------------------------------------------------

# Read a session's creation timestamp BY EXACT NAME.
#
# Two traps here, and each one made an assertion silently vacuous:
#
#   1. `display-message -t X` resolves X by exact match, then PREFIX, then
#      fnmatch. Once "marveen" is gone it reports on "marveen-channels" instead
#      -- the probe drifts to the sibling in precisely the state the incident
#      creates, so the watchdog is blind exactly when it matters.
#
#   2. Anchoring it as `display-message -t '=marveen'` does NOT fix that, and is
#      worse. In tmux 3.6 `-t` on display-message is a PANE target; the '='
#      anchor leaves it unresolvable, so it prints NOTHING and EXITS 0.
#      Measured against the live session on 2026-08-04: the unanchored form
#      returns 1785812212, the anchored form returns ''. And `$(probe || echo
#      absent)` only substitutes on a NON-ZERO exit, so an empty-but-successful
#      probe leaves both sides of a before/after comparison as '' -- which
#      compare EQUAL, and the suite prints "the live session was NOT touched"
#      having measured nothing at all. Thor demonstrated that same vacuous PASS
#      independently, including on the pre-fix script.
#
# list-sessions with an explicit format and an exact awk match has neither
# problem: no prefix resolution, and a missing session produces no line.
sess_stamp() {
  local out
  out=$(env -u TMUX tmux list-sessions -F '#{session_name}|#{session_created}' 2>/dev/null \
        | awk -F'|' -v n="$1" '$1 == n { print $2 }')
  if [[ -n "$out" ]]; then printf '%s\n' "$out"; else printf 'absent\n'; fi
}

# Create a fixture session and PROVE it came up. Under some tmux server states
# the spawned shell dies immediately (an inherited SHELLOPTS=nounset makes the
# rc file fail), and new-session still exits 0 -- so a case that assumes the
# fixture exists silently tests nothing. Callers must skip loudly on failure.
mk_session() {
  env -u TMUX tmux kill-session -t "=$1" 2>/dev/null || true
  TEST_SESSIONS="$TEST_SESSIONS $1"
  env -u TMUX tmux new-session -d -s "$1" 'sleep 300' 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    [[ "$(sess_stamp "$1")" != "absent" ]] && return 0
    sleep 0.1
  done
  return 1
}

mk_fixture() {   # $1 = base dir; sets FX_REPO, FX_BR
  FX_REPO="$1/repo"; FX_BR="$1/backups"
  mkdir -p "$FX_REPO/dist" "$FX_REPO/store" "$FX_REPO/scripts" "$FX_BR/20260701-000000"
  echo "LIVE BUILD"    > "$FX_REPO/dist/index.js"
  echo "stale asset"   > "$FX_REPO/dist/gone.js"      # must be removed by --delete
  echo "tok"           > "$FX_REPO/store/.dashboard-token"
  echo "OLDTIP"        > "$FX_REPO/store/.deployed-tip"
  cat > "$FX_REPO/scripts/update-deployed-tip.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$1" > "$(cd "$(dirname "$0")/.." && pwd)/store/.deployed-tip"
STUB
  echo "RESTORED BUILD" > "$FX_BR/20260701-000000/index.js"
  echo "$SHA"           > "$FX_BR/20260701-000000/deployed-sha.txt"
}

# The stub binds port 0 and PUBLISHES the port it got. Picking a free port in
# the test and handing it over is TOCTOU -- another process can take it in the
# gap, and the case flakes under load. (Thor, R3.)
start_stub() {   # $1 = base dir; sets STUB_PID, STUB_PORT
  local pf="$1/port"
  python3 - "$pf" <<'PY' &
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"pass": true}' if 'verify' in self.path else b'{"ok": true}'
        self.send_response(200); self.send_header('Content-Type','application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
srv = HTTPServer(('127.0.0.1', 0), H)
with open(sys.argv[1], 'w') as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
PY
  STUB_PID=$!
  local i
  for i in $(seq 1 50); do [[ -s "$pf" ]] && break; sleep 0.1; done
  STUB_PORT=$(cat "$pf" 2>/dev/null || echo "")
}

# Fail-closed PATH shield: log every tmux/curl call the script makes, and REFUSE
# any call naming a live target. Thor's T11, adopted wholesale because it is a
# better instrument than mine was: comparing the live timestamp detects that an
# accident HAPPENED, the shield detects that the script is CAPABLE of one. The
# first is one accident too late.
mk_shield() {    # $1 = dir, $2 = logfile
  local dir="$1" log="$2" b real
  mkdir -p "$dir"; : > "$log"
  for b in tmux curl; do
    real=$(command -v "$b")
    cat > "$dir/$b" <<SHIELD
#!/usr/bin/env bash
printf '%s %s\n' "$b" "\$*" >> "$log"
for a in "\$@"; do
  case "\$a" in
    *marveen*|*3420*)
      printf 'REFUSED %s %s\n' "$b" "\$*" >> "$log"
      exit 90 ;;
  esac
done
exec "$real" "\$@"
SHIELD
    chmod +x "$dir/$b"
  done
}

# The capability probe the two destructive cases gate on. Dave's R3 point: a
# grep for the NAME `ROLLBACK_SESSION` also matches a half-fixed revision that
# declares the variable and still hardcodes the target at the call site. Match
# the call site itself.
supports_session_override() {
  grep -qE 'kill-session[^\n]*\$\{?SESSION' "$1" && grep -q 'ROLLBACK_SESSION' "$1"
}

# --- 15. THE HAPPY PATH, fully enclosed. Until now this was the only part of the
#         break-glass tool nothing covered, and the reason was that the restart
#         block hardcoded `marveen` and http://localhost:3420 -- so a fixture-
#         directed run killed the real dashboard. Dave demonstrated exactly that
#         live on 2026-08-04 04:56:52. With ROLLBACK_SESSION/ROLLBACK_DASHBOARD the
#         run is enclosed and the restore+restart+verify path is finally testable.
#
#         SELF-GUARD, not optional: this case is destructive against a revision
#         WITHOUT the overrides -- and that revision is exactly what we point the
#         suite at when counter-testing. Detect the capability, skip loudly.
#         Never make the counter-test the dangerous operation.
if ! supports_session_override "$RB"; then
  echo "  SKIP: happy path -- $RB does not honour ROLLBACK_SESSION at its kill-session"
  echo "        call site, so running it would target the LIVE session. Expected when"
  echo "        counter-testing a pre-fix revision; it is not a pass."
else
LIVE_BEFORE=$(sess_stamp marveen)
if [[ "$LIVE_BEFORE" == "absent" ]]; then
  echo "  SKIP: happy path -- no live 'marveen' session to guard, so the"
  echo "        non-interference assertion would measure nothing. Refusing to"
  echo "        print a PASS for an unperformed measurement."
else
mk_fixture "$WORK/h"
start_stub  "$WORK/h"
TEST_SESSION="rollback-selftest-$$"
TEST_SESSIONS="$TEST_SESSIONS $TEST_SESSION"

if [[ -z "$STUB_PORT" ]]; then
  fail "happy path: stub dashboard never published a port"
else
out=$(ROLLBACK_REPO="$FX_REPO" ROLLBACK_BACKUP_ROOT="$FX_BR" \
      ROLLBACK_SESSION="$TEST_SESSION" ROLLBACK_DASHBOARD="http://127.0.0.1:$STUB_PORT" \
      bash "$RB" 2>&1); rc=$?

kill "$STUB_PID" 2>/dev/null
env -u TMUX tmux kill-session -t "=$TEST_SESSION" 2>/dev/null || true

LIVE_AFTER=$(sess_stamp marveen)

if [[ $rc -eq 0 ]] \
   && [[ "$(cat "$FX_REPO/dist/index.js")" == "RESTORED BUILD" ]] \
   && [[ ! -f "$FX_REPO/dist/gone.js" ]] \
   && [[ "$(cat "$FX_REPO/store/.deployed-tip")" == "$SHA" ]] \
   && [[ ! -f "$FX_REPO/store/planned-restart.marker" ]]; then
  pass "happy path: restore + restart + verify completes and relabels deployed-tip"
else
  fail "happy path (rc=$rc, index=$(cat "$FX_REPO/dist/index.js" 2>/dev/null), tip=$(cat "$FX_REPO/store/.deployed-tip" 2>/dev/null)): $out"
fi

# LIVE_BEFORE is known non-'absent' by the guard above, so this comparison is
# never the empty-equals-empty tautology it used to be.
if [[ "$LIVE_BEFORE" == "$LIVE_AFTER" ]]; then
  pass "the live marveen session was NOT touched by a fixture-directed run"
else
  fail "A FIXTURE RUN DISTURBED THE LIVE SESSION: before=$LIVE_BEFORE after=$LIVE_AFTER"
fi
fi
fi
fi

# --- 16. THE SIBLING-SESSION KILL: the missing half of the 04:56:52 incident,
#         and until now not one line covered it.
#
#         `tmux -t NAME` is bound to the session we mean only while that session
#         EXISTS. Once it is gone -- previous kill, crash, supervisor mid-restart
#         -- the identical literal command matches "NAME-channels" by prefix and
#         kills the orchestrator, silently, rc=0. Reproduced by Genesis and
#         confirmed independently here: create X and X-channels, run
#         `kill-session -t X` twice, and the second call takes X-channels.  # tmux-anchor-lint: ignore
#
#         So "this script targets one session by exact name" was wrong. It is
#         exact only in the state where the check is redundant. For a break-glass
#         tool the target session is missing precisely WHEN THE TOOL IS NEEDED,
#         which makes the prefix fallback the expected case, not the edge case.
#         The fix is the '=' anchor, which disables both fallbacks.
if ! supports_session_override "$RB"; then
  echo "  SKIP: sibling-session kill -- $RB does not honour ROLLBACK_SESSION at its"
  echo "        kill-session call site, so this case would aim at the live 'marveen'"
  echo "        prefix. Expected when counter-testing a pre-fix revision."
else
SIB_BASE="rollback-sibtest-$$"
TEST_SESSIONS="$TEST_SESSIONS $SIB_BASE"
if ! mk_session "${SIB_BASE}-channels"; then
  echo "  SKIP: sibling-session kill -- could not bring up a fixture session on this"
  echo "        tmux server, so the assertion would compare two absences and pass."
else
mk_fixture "$WORK/s"
start_stub  "$WORK/s"
SIB_BEFORE=$(sess_stamp "${SIB_BASE}-channels")

# The target is deliberately ABSENT and only the sibling exists -- the exact
# state the fleet is in whenever a dashboard session is down and the
# orchestrator is up.
ROLLBACK_REPO="$FX_REPO" ROLLBACK_BACKUP_ROOT="$FX_BR" \
  ROLLBACK_SESSION="$SIB_BASE" ROLLBACK_DASHBOARD="http://127.0.0.1:$STUB_PORT" \
  bash "$RB" >/dev/null 2>&1 || true

SIB_AFTER=$(sess_stamp "${SIB_BASE}-channels")
kill "$STUB_PID" 2>/dev/null
env -u TMUX tmux kill-session -t "=$SIB_BASE" 2>/dev/null || true
env -u TMUX tmux kill-session -t "=${SIB_BASE}-channels" 2>/dev/null || true

if [[ "$SIB_BEFORE" != "absent" && "$SIB_BEFORE" == "$SIB_AFTER" ]]; then
  pass "a sibling '<name>-channels' session survives a rollback aimed at the absent '<name>'"
else
  fail "PREFIX-MATCH KILL: rollback aimed at absent '$SIB_BASE' took '${SIB_BASE}-channels' (before=$SIB_BEFORE after=$SIB_AFTER)"
fi
fi
fi

# --- 17. CAPABILITY, NOT OCCURRENCE (Thor's T11).
#
#         Cases 15 and 16 detect that an accident HAPPENED. This one detects that
#         the script is ABLE to cause one, which is a strictly earlier signal --
#         and because the shield refuses live targets rather than relying on the
#         script to be well-behaved, it is the one case that is SAFE to run
#         against any revision. That matters: 15 and 16 skip on a pre-fix script,
#         so without this the counter-test proves nothing about the live-target
#         behaviour it is supposed to be checking.
#
#         The second assertion is the one that keeps it honest: a script that
#         dies before the restart block makes no calls at all, and "named no live
#         target" would otherwise be a free pass for doing nothing.
SHIELD_DIR="$WORK/shield"; SHIELD_LOG="$WORK/shield-calls.log"
mk_shield "$SHIELD_DIR" "$SHIELD_LOG"
mk_fixture "$WORK/c"
start_stub  "$WORK/c"
CAP_SESSION="rollback-captest-$$"
TEST_SESSIONS="$TEST_SESSIONS $CAP_SESSION"

PATH="$SHIELD_DIR:$PATH" \
  ROLLBACK_REPO="$FX_REPO" ROLLBACK_BACKUP_ROOT="$FX_BR" \
  ROLLBACK_SESSION="$CAP_SESSION" ROLLBACK_DASHBOARD="http://127.0.0.1:$STUB_PORT" \
  bash "$RB" >/dev/null 2>&1 || true

kill "$STUB_PID" 2>/dev/null
env -u TMUX tmux kill-session -t "=$CAP_SESSION" 2>/dev/null || true

# `|| true`, NOT `|| echo 0`: grep -c already PRINTS 0 when it matches nothing and
# then exits 1, so the fallback appends a second zero and the value becomes the
# two-line string "0\n0" -- which blows up [[ -eq ]] with an arithmetic syntax
# error and reports a failure that is really a bug in the harness.
REFUSED=$(grep -c '^REFUSED' "$SHIELD_LOG" 2>/dev/null || true)
SESSCALLS=$(grep -cE '^tmux (kill-session|new-session)' "$SHIELD_LOG" 2>/dev/null || true)

if [[ "$REFUSED" -eq 0 ]]; then
  pass "a fixture-directed run names no live target (no tmux/curl call mentioned marveen or 3420)"
else
  fail "THE SCRIPT CAN STILL REACH LIVE TARGETS -- $REFUSED refused call(s):
$(grep '^REFUSED' "$SHIELD_LOG" | sed 's/^/      /')"
fi

if [[ "$SESSCALLS" -ge 2 ]]; then
  pass "the restart block actually ran ($SESSCALLS session calls observed, so the check above is not vacuous)"
else
  fail "no restart activity observed ($SESSCALLS session calls) -- the 'no live target' result above proves nothing"
fi

echo
if [[ "$FAIL" -gt 0 ]]; then echo "FAILED ($FAIL)"; exit 1; fi
echo "OK"
