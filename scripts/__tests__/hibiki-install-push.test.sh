#!/bin/bash
# Unit tests for the cron toggling in hibiki-install-push.sh.
#
# Delivery is now the supervisor tick by default; cron is opt-in legacy. These
# tests exercise the --cron (install) and --uninstall-cron (remove) paths against
# a FAKE `crontab` on PATH, so they never touch the real user crontab. The default
# path's removal reuses the same remove_cron(), so --uninstall-cron covers it.
# Only the do_seed=0 modes are run, so the worktree store is never seeded.
#
# Run: bash scripts/__tests__/hibiki-install-push.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$INSTALL_DIR/scripts/hibiki-install-push.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# Fake crontab shim: -l prints the store file; - reads stdin into it.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/crontab" <<'SHIM'
#!/bin/bash
f="${FAKE_CRONTAB_FILE:?}"
case "${1:-}" in
  -l) [ -f "$f" ] && cat "$f" || { echo "no crontab for user" >&2; exit 1; } ;;
  -)  cat > "$f" ;;
  -r) rm -f "$f" ;;
  *)  echo "fake crontab: unsupported arg '$*'" >&2; exit 2 ;;
esac
SHIM
chmod +x "$TMP/bin/crontab"

export FAKE_CRONTAB_FILE="$TMP/crontab.txt"
export PATH="$TMP/bin:$PATH"
MARKER="# HIBIKI-DAILY-PUSH"

count_marker() {
  # grep -c prints "0" AND exits 1 on no match; capture so we emit a single value.
  local c
  c=$(grep -cF "$MARKER" "$FAKE_CRONTAB_FILE" 2>/dev/null) || c=0
  echo "$c"
}

# --- --cron installs exactly one managed line ------------------------------
rm -f "$FAKE_CRONTAB_FILE"
bash "$SCRIPT" --cron >/dev/null 2>&1
[ "$(count_marker)" = "1" ] && pass "--cron installs the managed line" \
  || fail "--cron installs the managed line (got $(count_marker))"
grep -q '\*/5 \* \* \* \*' "$FAKE_CRONTAB_FILE" && pass "--cron line is the 5-min schedule" \
  || fail "--cron line is the 5-min schedule"

# --- --cron is idempotent (no duplicate line) ------------------------------
bash "$SCRIPT" --cron >/dev/null 2>&1
[ "$(count_marker)" = "1" ] && pass "--cron is idempotent (still one line)" \
  || fail "--cron is idempotent (got $(count_marker))"

# --- --uninstall-cron removes ours, preserves unrelated entries ------------
printf '0 9 * * * echo unrelated-job\n' > "$FAKE_CRONTAB_FILE"
bash "$SCRIPT" --cron >/dev/null 2>&1          # now: unrelated + ours
bash "$SCRIPT" --uninstall-cron >/dev/null 2>&1
[ "$(count_marker)" = "0" ] && pass "--uninstall-cron removes the managed line" \
  || fail "--uninstall-cron removes the managed line (got $(count_marker))"
grep -q "unrelated-job" "$FAKE_CRONTAB_FILE" && pass "--uninstall-cron preserves unrelated entries" \
  || fail "--uninstall-cron preserves unrelated entries"

# --- --uninstall-cron on a crontab with ONLY ours empties it cleanly -------
rm -f "$FAKE_CRONTAB_FILE"
bash "$SCRIPT" --cron >/dev/null 2>&1           # only ours
bash "$SCRIPT" --uninstall-cron >/dev/null 2>&1
[ "$(count_marker)" = "0" ] && pass "--uninstall-cron clears a single-entry crontab" \
  || fail "--uninstall-cron clears a single-entry crontab (got $(count_marker))"

# --- unknown option exits non-zero -----------------------------------------
if bash "$SCRIPT" --bogus >/dev/null 2>&1; then
  fail "unknown option should exit non-zero"
else
  pass "unknown option exits non-zero"
fi

echo ""
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAIL FAILED"; exit 1; fi
