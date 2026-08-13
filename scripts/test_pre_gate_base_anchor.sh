#!/usr/bin/env bash
# Discriminating regression test for the pre-gate-bundle base-anchor signal.
#
# CONTRACT UNDER TEST (card ENG/9c741d06, roberts):
#   When `git fetch origin` FAILS, the bundle must SAY SO. It must not silently
#   3-dot-diff against a stale on-disk origin/<branch> while emitting the same
#   green output as a successful fetch.
#
# WHY THIS TEST EXISTS IN THIS SHAPE:
#   The bundle's base-anchor logic lives INLINE in main() (pre-gate-bundle.sh:752-759),
#   not in a pure helper, so scripts/test_pre_gate_bundle.sh (which sources the script
#   and calls pgb_* helpers) structurally cannot reach it. Hence a hermetic end-to-end
#   run against a scratch repo with a deliberately broken remote.
#
# DISCRIMINATION REQUIREMENT (the point of the whole exercise):
#   This test MUST FAIL on the pre-fix code. If it passes both before and after the
#   fix, it measures nothing. Run it on current develop to see it FAIL -- that failure
#   IS the evidence that the fix is needed and that the test can detect it.
#
# Run: bash scripts/test_pre_gate_base_anchor.sh [path/to/pre-gate-bundle.sh]
#
# Author: morgan (fixture + discriminating assertions), vendored by roberts for ENG/9c741d06.
set -uo pipefail

BUNDLE="${1:-"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pre-gate-bundle.sh"}"
[ -f "$BUNDLE" ] || { echo "no bundle script at $BUNDLE" >&2; exit 2; }

WORK="$(mktemp -d /tmp/pgb-baseanchor-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

# --------------------------------------------------------------------------- #
# Fixture: upstream + clone, then upstream advances, then the remote is broken. #
# --------------------------------------------------------------------------- #
git init -q "$WORK/upstream"
git -C "$WORK/upstream" config user.email t@t; git -C "$WORK/upstream" config user.name t
mkdir -p "$WORK/upstream/scripts"
cp "$BUNDLE" "$WORK/upstream/scripts/pre-gate-bundle.sh"
[ -f "$(dirname "$BUNDLE")/pre-gate-schema.json" ] &&
  cp "$(dirname "$BUNDLE")/pre-gate-schema.json" "$WORK/upstream/scripts/"
echo v1 > "$WORK/upstream/f.txt"
git -C "$WORK/upstream" add -A
git -C "$WORK/upstream" commit -qm c1
git -C "$WORK/upstream" branch -M develop

git clone -q "$WORK/upstream" "$WORK/clone" 2>/dev/null
CLONE="$WORK/clone"

# upstream moves on; the clone does NOT know about it yet
echo v2 > "$WORK/upstream/f.txt"
git -C "$WORK/upstream" commit -qam c2
REAL_TIP="$(git -C "$WORK/upstream" rev-parse --short develop)"
STALE_TIP="$(git -C "$CLONE" rev-parse --short origin/develop)"

[ "$REAL_TIP" != "$STALE_TIP" ] ||
  { echo "fixture broken: tips identical" >&2; exit 2; }

# break the remote so `git fetch origin` cannot succeed
git -C "$CLONE" remote set-url origin "$WORK/nonexistent-remote"

echo "fixture: stale origin/develop=$STALE_TIP  real upstream tip=$REAL_TIP"
echo

# --------------------------------------------------------------------------- #
# Precondition: the failure really is silent at the git layer.                  #
# --------------------------------------------------------------------------- #
git -C "$CLONE" fetch origin --quiet 2>/dev/null || true
FETCH_LINE_EXIT=$?
[ "$FETCH_LINE_EXIT" -eq 0 ] &&
  ok "precondition: '|| true' swallows the fetch failure (exit 0)" ||
  bad "precondition: expected exit 0 from the guarded fetch line"

AFTER="$(git -C "$CLONE" rev-parse --short origin/develop)"
[ "$AFTER" = "$STALE_TIP" ] &&
  ok "precondition: origin/develop still stale after failed fetch ($AFTER)" ||
  bad "precondition: origin/develop unexpectedly moved to $AFTER"

# --------------------------------------------------------------------------- #
# THE ACTUAL ASSERTIONS -- these are what must fail pre-fix.                    #
# --------------------------------------------------------------------------- #
# Hermetic PATH: everything the bundle needs EXCEPT npx/npm/node, so typecheck and
# tests take their cheap "toolchain missing -> WARN" branch instead of really running
# tsc/vitest against a scratch repo that has no package.json. This test asserts only
# the base-anchor signal; the other checks must not influence its outcome.
mkdir -p "$WORK/bin"
for t in git python3 bash sh grep egrep sed awk cut tr sort uniq head tail cat wc \
         find xargs dirname basename mktemp rm mv cp ls date comm diff printf env; do
  src="$(command -v "$t" 2>/dev/null)" && ln -sf "$src" "$WORK/bin/$t"
done
command -v npx >/dev/null && ! [ -e "$WORK/bin/npx" ] &&
  ok "hermetic PATH excludes npx (typecheck/tests stay on the WARN branch)"

HEAD_SHA="$(git -C "$CLONE" rev-parse HEAD)"
run_bundle() {  # extra-args...
  (cd "$CLONE" && env -i PATH="$WORK/bin" HOME="$HOME" \
    bash scripts/pre-gate-bundle.sh develop "$HEAD_SHA" "$@" 2>&1)
}
TEXT_OUT="$(run_bundle)"
JSON_OUT="$(run_bundle --json)"

# 1) text mode must carry a visible warning that the base could not be refreshed
if printf '%s' "$TEXT_OUT" | grep -qiE 'base-fetch|base anchor|stale.*(base|origin)'; then
  ok "text output reports the failed base fetch"
else
  bad "text output is SILENT about the failed base fetch (stale base presented as normal)"
fi

# 2) json mode must expose it as a machine-readable field
if printf '%s' "$JSON_OUT" | grep -qE '"base_anchor"[[:space:]]*:[[:space:]]*"stale"'; then
  ok "json exposes base_anchor=stale"
else
  bad "json has no base_anchor=stale field (consumers cannot tell fresh from stale)"
fi

# 3) the signal must be advisory, not a hard block (roberts: fail-open STAYS).
#    NOTE: assert on the BASE-FETCH LINE specifically, never on the overall verdict --
#    in a scratch repo typecheck/tests BLOCK for unrelated reasons, so a verdict-level
#    assertion would fail for the wrong cause. (First draft of this test had exactly
#    that bug: a non-discriminating assertion pointed the other way.)
BASE_LINE="$(printf '%s\n' "$TEXT_OUT" | grep -iE 'base-fetch|base anchor' || true)"
if [ -z "$BASE_LINE" ]; then
  echo "SKIP  fail-open assertion: no base-fetch line emitted yet (expected pre-fix)"
elif printf '%s' "$BASE_LINE" | grep -qE '\[BLOCK'; then
  bad "base-fetch reported as BLOCK (contract says advisory WARN only)"
else
  ok "base-fetch reported without BLOCK (fail-open preserved)"
fi

# --------------------------------------------------------------------------- #
# 4) HAPPY-PATH COUNTER-CHECK -- guards against a degenerate implementation.    #
#    Without this, `BASE_ANCHOR=stale` hardcoded unconditionally would pass all #
#    the assertions above. A signal that is always on is not a signal.          #
# --------------------------------------------------------------------------- #
git -C "$CLONE" remote set-url origin "$WORK/upstream"     # repair the remote
OK_TEXT="$(run_bundle)"
OK_JSON="$(run_bundle --json)"

if printf '%s' "$OK_TEXT" | grep -qiE 'base-fetch|base anchor'; then
  bad "counter-check: base-fetch warning still emitted on a WORKING remote (always-on signal)"
else
  ok "counter-check: no base-fetch warning when the fetch succeeds"
fi

if printf '%s' "$OK_JSON" | grep -qE '"base_anchor"[[:space:]]*:[[:space:]]*"stale"'; then
  bad "counter-check: base_anchor still 'stale' after a successful fetch"
elif printf '%s' "$OK_JSON" | grep -qE '"base_anchor"[[:space:]]*:[[:space:]]*"fetched"'; then
  ok "counter-check: base_anchor='fetched' after a successful fetch"
else
  echo "SKIP  counter-check json: no base_anchor field at all (expected pre-fix)"
fi

# the repaired fetch must actually have advanced the on-disk ref -- proves the
# counter-check exercised a genuinely different state, not just a quiet failure
NOW="$(git -C "$CLONE" rev-parse --short origin/develop)"
[ "$NOW" = "$REAL_TIP" ] &&
  ok "counter-check fixture: origin/develop advanced $STALE_TIP -> $NOW" ||
  bad "counter-check fixture: origin/develop is $NOW, expected $REAL_TIP"

echo
echo "--- bundle text output, BROKEN remote (for the record) ---"
printf '%s\n' "$TEXT_OUT" | sed 's/^/    /'
echo
printf 'passed=%d failed=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
