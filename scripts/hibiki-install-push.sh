#!/usr/bin/env bash
# Install the Hibiki token-free daily push (spec B-AC2).
#
# Two steps, both idempotent:
#   1. Seed the private store (agents/hibiki/store/) from the tracked examples,
#      WITHOUT overwriting any file that already exists (never clobbers real
#      health data). Files are chmod 600.
#   2. Install a SYSTEM CRON entry that runs the push every 5 minutes, regardless
#      of any Claude session (this is the whole point: token-free).
#
# This is a DEPLOY/LAUNCH step. It is intentionally NOT run during development.
# It is run by whoever provisions Hibiki (fleet owner / Genesis), AFTER:
#   - Hibiki's Telegram bot token is in agents/hibiki/.claude/channels/telegram/.env
#   - push-config.json has the real chat_id
#   - signature.txt holds the confirmed signature (NOT the placeholder)
#
# Usage:
#   scripts/hibiki-install-push.sh            # seed missing files + install cron
#   scripts/hibiki-install-push.sh --seed     # seed only
#   scripts/hibiki-install-push.sh --cron     # install cron only
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE="$REPO_ROOT/agents/hibiki/store"
EXAMPLES="$REPO_ROOT/scripts/hibiki-examples"
PUSH="$REPO_ROOT/scripts/hibiki-daily-push.py"
CRON_MARKER="# HIBIKI-DAILY-PUSH"
LOG="$STORE/push.log"

do_seed=1
do_cron=1
case "${1:-}" in
  --seed) do_cron=0 ;;
  --cron) do_seed=0 ;;
  "") ;;
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

if [[ "$do_cron" == 1 ]]; then
  echo "Installing cron entry (every 5 minutes)..."
  line="*/5 * * * * cd $REPO_ROOT && /usr/bin/env python3 $PUSH --quiet >> $LOG 2>&1 $CRON_MARKER"
  current="$(crontab -l 2>/dev/null || true)"
  if grep -qF "$CRON_MARKER" <<<"$current"; then
    # Replace the existing managed line (in case the path changed).
    new="$(grep -vF "$CRON_MARKER" <<<"$current")"
    printf '%s\n%s\n' "$new" "$line" | sed '/^$/d' | crontab -
    echo "  updated existing managed cron entry"
  else
    printf '%s\n%s\n' "$current" "$line" | sed '/^$/d' | crontab -
    echo "  added new cron entry"
  fi
  echo "Verify with: crontab -l | grep '$CRON_MARKER'"
  echo "NOTE (WSL/no-systemd): cron may need starting once, e.g. 'sudo service cron start'."
  echo "Alternative if cron is unavailable: register the push in fleet-supervisor.sh as a"
  echo "watchdog-pattern tick (always-on process) -- see docs/hibiki-pipeline.md."
fi
