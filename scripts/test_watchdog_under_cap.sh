#!/bin/bash
# Tests for wd_under_cap_file + wd_under_cap_stamp in scripts/lib/watchdog-common.sh
# (card 0b282eb0 Phase-2: file-backed under_cap replacing inline STAMPS array).
#
# F3 mitigation: file-backed design avoids nameref silent-fail entirely.
# F6 contract: wd_under_cap_file does NOT stamp; caller stamps explicitly before launch.
# F4 (set -u safety): all functions verified safe under set -u in a sourcing context.
#
# Run: bash scripts/test_watchdog_under_cap.sh

set -u

LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/watchdog-common.sh"
# shellcheck disable=SC1090
. "$LIB" || { echo "FATAL: cannot source $LIB"; exit 1; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

now=$(date +%s)
old=$((now - 4000))     # >3600s ago -- must be pruned
recent=$((now - 60))    # within 3600s -- must be kept
future=$((now + 30))    # future timestamp -- kept (not yet expired)

# ---------------------------------------------------------------------------
# wd_under_cap_file: missing / empty file
# ---------------------------------------------------------------------------

f="$(mktemp)"; rm -f "$f"
wd_under_cap_file "$f" 8 && ok "under_cap_file: missing file -> under cap (fail-safe)" \
                           || bad "under_cap_file: missing file should be under cap"

f="$(mktemp)"  # empty (mktemp creates it)
wd_under_cap_file "$f" 8 && ok "under_cap_file: empty file -> under cap" \
                           || bad "under_cap_file: empty file should be under cap"
rm -f "$f"

# Empty-string stampfile -> fail-safe under cap (no crash)
wd_under_cap_file "" 8 2>/dev/null; rc=$?
[ "$rc" -eq 0 ] && ok "under_cap_file: empty stampfile arg -> under cap (fail-safe)" \
                 || bad "under_cap_file: empty stampfile should be under cap, got rc=$rc"

# ---------------------------------------------------------------------------
# wd_under_cap_file: count strictly less than max -> under cap
# ---------------------------------------------------------------------------

f="$(mktemp)"
printf '%s\n%s\n%s\n' "$recent" "$recent" "$recent" > "$f"
wd_under_cap_file "$f" 8 && ok "under_cap_file: 3 of 8 -> under cap" \
                           || bad "under_cap_file: 3 of 8 should be under cap"
rm -f "$f"

# max=1: 0 stamps -> under cap
f="$(mktemp)"
wd_under_cap_file "$f" 1 && ok "under_cap_file: 0 of 1 -> under cap" \
                           || bad "under_cap_file: 0 of 1 should be under cap"
rm -f "$f"

# ---------------------------------------------------------------------------
# wd_under_cap_file: count == max -> at cap (returns 1)
# ---------------------------------------------------------------------------

f="$(mktemp)"
printf '%s\n' "$recent" "$recent" "$recent" \
              "$recent" "$recent" "$recent" \
              "$recent" "$recent" > "$f"  # 8 entries
wd_under_cap_file "$f" 8 \
  && bad "under_cap_file: 8 of 8 -> AT cap, must return 1" \
  || ok  "under_cap_file: 8 of 8 -> at cap"
rm -f "$f"

# max=1: 1 recent stamp -> at cap
f="$(mktemp)"
printf '%s\n' "$recent" > "$f"
wd_under_cap_file "$f" 1 \
  && bad "under_cap_file: 1 of 1 -> AT cap, must return 1" \
  || ok  "under_cap_file: 1 of 1 -> at cap"
rm -f "$f"

# ---------------------------------------------------------------------------
# wd_under_cap_file: old stamps are pruned; net count < max
# ---------------------------------------------------------------------------

f="$(mktemp)"
printf '%s\n%s\n%s\n' "$old" "$old" "$recent" > "$f"
wd_under_cap_file "$f" 8 && ok "under_cap_file: 2 old+1 recent -> prunes to 1, under cap" \
                           || bad "under_cap_file: 2 old+1 recent should be under cap after prune"
count="$(grep -c '' "$f" 2>/dev/null || echo 0)"
[ "$count" -eq 1 ] && ok "under_cap_file: old entries removed from file" \
                    || bad "under_cap_file: expected 1 line after prune, got $count"
rm -f "$f"

# ---------------------------------------------------------------------------
# wd_under_cap_file: old stamps pruned; net count == max -> still at cap
# ---------------------------------------------------------------------------

f="$(mktemp)"
{
  printf '%s\n' "$old"
  for _ in 1 2 3 4 5 6 7 8; do printf '%s\n' "$recent"; done
} > "$f"  # 1 old + 8 recent
wd_under_cap_file "$f" 8 \
  && bad "under_cap_file: 1 old+8 recent -> prunes to 8, still at cap" \
  || ok  "under_cap_file: 1 old+8 recent -> at cap after prune"
rm -f "$f"

# ---------------------------------------------------------------------------
# wd_under_cap_file: future timestamps are kept (not yet expired)
# ---------------------------------------------------------------------------

f="$(mktemp)"
printf '%s\n' "$future" > "$f"
wd_under_cap_file "$f" 8 && ok "under_cap_file: 1 future stamp -> kept, under cap" \
                           || bad "under_cap_file: future stamp should be kept"
count="$(grep -c '' "$f" 2>/dev/null || echo 0)"
[ "$count" -eq 1 ] && ok "under_cap_file: future stamp preserved in file" \
                    || bad "under_cap_file: future stamp should remain, got $count lines"
rm -f "$f"

# ---------------------------------------------------------------------------
# wd_under_cap_file: non-numeric lines are skipped (corrupt entry)
# ---------------------------------------------------------------------------

f="$(mktemp)"
printf '%s\n' "not-a-number" "$recent" "" "$recent" > "$f"
wd_under_cap_file "$f" 8 && ok "under_cap_file: corrupt lines skipped, 2 recent -> under cap" \
                           || bad "under_cap_file: corrupt lines should be skipped"
count="$(grep -c '' "$f" 2>/dev/null || echo 0)"
[ "$count" -eq 2 ] && ok "under_cap_file: corrupt+empty lines removed from file" \
                    || bad "under_cap_file: expected 2 clean lines, got $count"
rm -f "$f"

# ---------------------------------------------------------------------------
# wd_under_cap_file: does NOT add a stamp (F6 contract)
# ---------------------------------------------------------------------------

f="$(mktemp)"
printf '%s\n' "$recent" "$recent" > "$f"
wd_under_cap_file "$f" 8
count="$(grep -c '' "$f" 2>/dev/null || echo 0)"
[ "$count" -eq 2 ] && ok "under_cap_file: does not add stamp on check (F6)" \
                    || bad "under_cap_file: must not add stamp, got $count lines"
rm -f "$f"

# ---------------------------------------------------------------------------
# wd_under_cap_stamp: creates file if missing
# ---------------------------------------------------------------------------

f="$(mktemp)"; rm -f "$f"
wd_under_cap_stamp "$f"
count="$(grep -c '' "$f" 2>/dev/null || echo 0)"
[ "$count" -eq 1 ] && ok "under_cap_stamp: creates file with one entry" \
                    || bad "under_cap_stamp: expected 1 line, got $count"
rm -f "$f"

# ---------------------------------------------------------------------------
# wd_under_cap_stamp: appends to existing file
# ---------------------------------------------------------------------------

f="$(mktemp)"
printf '%s\n' "$recent" > "$f"
wd_under_cap_stamp "$f"
count="$(grep -c '' "$f" 2>/dev/null || echo 0)"
[ "$count" -eq 2 ] && ok "under_cap_stamp: appends to existing file" \
                    || bad "under_cap_stamp: expected 2 lines, got $count"
rm -f "$f"

# ---------------------------------------------------------------------------
# wd_under_cap_stamp: timestamp is numeric and recent
# ---------------------------------------------------------------------------

f="$(mktemp)"; rm -f "$f"
wd_under_cap_stamp "$f"
ts="$(tr -d '[:space:]' < "$f")"
{ [ -n "$ts" ] && [ "$ts" -ge "$now" ] 2>/dev/null && [ "$ts" -lt $((now + 5)) ] 2>/dev/null; } \
  && ok "under_cap_stamp: timestamp is current epoch" \
  || bad "under_cap_stamp: expected current epoch, got '$ts'"
rm -f "$f"

# ---------------------------------------------------------------------------
# wd_under_cap_stamp: empty-string arg -> no crash (fail-safe)
# ---------------------------------------------------------------------------

wd_under_cap_stamp "" 2>/dev/null; rc=$?
[ "$rc" -ne 127 ] && ok "under_cap_stamp: empty arg -> no crash" \
                   || bad "under_cap_stamp: crashed with empty arg, rc=$rc"

# ---------------------------------------------------------------------------
# Integration: stamp-before-launch pattern (F6)
# Record two stamps manually, verify cap logic works end-to-end.
# ---------------------------------------------------------------------------

f="$(mktemp)"; rm -f "$f"
wd_under_cap_file "$f" 2 && ok "integration: 0 of 2 -> under cap" \
                           || bad "integration: 0 of 2 should be under cap"
wd_under_cap_stamp "$f"   # stamp 1 (before first launch)
wd_under_cap_file "$f" 2 && ok "integration: 1 of 2 -> under cap" \
                           || bad "integration: 1 of 2 should be under cap"
wd_under_cap_stamp "$f"   # stamp 2 (before second launch)
wd_under_cap_file "$f" 2 \
  && bad "integration: 2 of 2 -> at cap, must return 1" \
  || ok  "integration: 2 of 2 -> at cap"
rm -f "$f"

# ---------------------------------------------------------------------------

echo ""
echo "watchdog-under-cap: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
