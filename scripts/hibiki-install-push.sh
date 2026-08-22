#!/usr/bin/env bash
# Install the Hibiki token-free daily push (spec B-AC2).
#
# Delivery model (2026-06-08): the push is ticked by fleet-supervisor.sh, which is
# always-on and reboot-persistent (started from fleet-boot.sh). That is the DEFAULT
# and needs no cron daemon and no sudo. WSL has no systemd, so a real cron daemon
# needs `sudo service cron start` after every boot -- too fragile for a token-free
# guarantee -- so cron is now an OPT-IN legacy path only.
#
# This script:
#   1. Seeds the private store (agents/hibiki/store/) from the tracked examples,
#      WITHOUT overwriting any file that already exists (never clobbers real health
#      data). Files are chmod 600.
#   2. In the default path, removes any stale managed cron entry (so a host that was
#      previously cron-installed migrates cleanly onto the supervisor tick).
#
# This is a DEPLOY/LAUNCH step. It is intentionally NOT run during development.
# It is run by whoever provisions Hibiki (fleet owner / Genesis), AFTER:
#   - Hibiki's Telegram bot token is in agents/hibiki/.claude/channels/telegram/.env
#   - push-config.json has the real chat_id
#   - signature.txt holds the confirmed signature (NOT the placeholder)
#
# Usage:
#   scripts/hibiki-install-push.sh                  # seed missing files + migrate off stale cron
#   scripts/hibiki-install-push.sh --seed           # seed only (do not touch cron)
#   scripts/hibiki-install-push.sh --cron           # OPT-IN: install the legacy cron entry
#   scripts/hibiki-install-push.sh --uninstall-cron # remove the managed cron entry only
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="$REPO_ROOT/agents/hibiki/store"
EXAMPLES="$REPO_ROOT/scripts/hibiki-examples"
PUSH="$REPO_ROOT/scripts/hibiki-daily-push.py"
CRON_MARKER="# HIBIKI-DAILY-PUSH"
LOG="$STORE/push.log"

do_seed=1
mode="default"
case "${1:-}" in
  --seed)           mode="seed" ;;
  --cron)           mode="cron"; do_seed=0 ;;
  --uninstall-cron) mode="uninstall-cron"; do_seed=0 ;;
  "")               mode="default" ;;
  *) echo "unknown option: $1" >&2; exit 64 ;;
esac

seed_one() {
  local src="$1" dst="$2"
  if [[ -e "$dst" ]]; then
    echo "  keep   $(basename "$dst") (already exists, not overwritten)"
  else
    cp "$src" "$dst"
    chmod 600 "$dst"
    echo "  seed   $(basename "$dst")"
  fi
}

# Remove the single managed cron line, leaving any other crontab entries intact.
remove_cron() {
  local current new
  current="$(crontab -l 2>/dev/null || true)"
  if grep -qF "$CRON_MARKER" <<<"$current"; then
    # grep -v exits 1 when nothing remains (the marker was the only line); under
    # set -e that would abort before crontab is rewritten, leaving the stale line.
    new="$(grep -vF "$CRON_MARKER" <<<"$current" || true)"
    printf '%s\n' "$new" | sed '/^$/d' | crontab -
    echo "  removed managed cron entry ($CRON_MARKER)"
  else
    echo "  no managed cron entry present"
  fi
}

# OPT-IN legacy path: install/refresh the every-5-minutes cron entry. Most hosts
# should use the supervisor tick (the default) instead.
install_cron() {
  echo "Installing cron entry (every 5 minutes; OPT-IN legacy path)..."
  # Quote every path so the line survives spaces in the repo path (common on WSL,
  # e.g. /mnt/c/Users/...); an unquoted path silently breaks the token-free cron.
  local line current new
  line="*/5 * * * * cd \"$REPO_ROOT\" && /usr/bin/env python3 \"$PUSH\" --quiet >> \"$LOG\" 2>&1 $CRON_MARKER"
  current="$(crontab -l 2>/dev/null || true)"
  if grep -qF "$CRON_MARKER" <<<"$current"; then
    new="$(grep -vF "$CRON_MARKER" <<<"$current" || true)"
    printf '%s\n%s\n' "$new" "$line" | sed '/^$/d' | crontab -
    echo "  updated existing managed cron entry"
  else
    printf '%s\n%s\n' "$current" "$line" | sed '/^$/d' | crontab -
    echo "  added new cron entry"
  fi
  echo "Verify: crontab -l | grep '$CRON_MARKER'"
  echo "NOTE (WSL/no-systemd): cron needs 'sudo service cron start' after each boot --"
  echo "this is exactly why the supervisor-tick path is now the default."
}

if [[ "$do_seed" == 1 ]]; then
  echo "Seeding private store: $STORE"
  mkdir -p "$STORE/plans"
  seed_one "$EXAMPLES/push-config.json"           "$STORE/push-config.json"
  seed_one "$EXAMPLES/signature.txt"              "$STORE/signature.txt"
  seed_one "$EXAMPLES/hibiki-supplements.json"    "$STORE/hibiki-supplements.json"
  seed_one "$EXAMPLES/hibiki-progress.json"       "$STORE/hibiki-progress.json"
  seed_one "$EXAMPLES/hibiki-plan-2026-W24.json"  "$STORE/plans/hibiki-plan-2026-W24.json"
  echo "Done seeding. Edit push-config.json (chat_id) and signature.txt before going live."
fi

case "$mode" in
  default)
    echo "Daily push delivery: fleet-supervisor.sh tick (reboot-safe, no cron/sudo)."
    remove_cron
    ;;
  cron)           install_cron ;;
  uninstall-cron) remove_cron ;;
  seed)           : ;;  # seed only, leave cron untouched
esac
