#!/usr/bin/env bash
# P9 sandbox start (card p9-sandbox-foundation).
#
# Starts the dashboard in an isolated tmux session `noa-sandbox` using:
#   - NOA_DB_PATH -> store/sandbox/noa.db  (never touches live noa.db)
#   - WEB_PORT=3430                         (never conflicts with live :3420)
#   - SANDBOX_ISOLATION=1                   (hard-abort guard in db.ts)
#   - all channel tokens cleared            (no outbound Telegram/Slack/Discord)
#   - RESPAWN_ENABLED=false                 (no agent spawning from sandbox)
#   - NOA_BOOT_SMOKE not set               (full init, schedulers/etc ON)
#
# Usage:
#   bash scripts/sandbox-start.sh           -- start (kill existing session first)
#   bash scripts/sandbox-start.sh --smoke   -- smoke-only boot (db+web, no schedulers)
#
# Prerequisites: bash scripts/sandbox-setup.sh must have run first.
#
# Logs: store/sandbox/sandbox.log

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX_DIR="$REPO/store/sandbox"
SANDBOX_SESSION="noa-sandbox"
SANDBOX_PORT=3430
LOG="$SANDBOX_DIR/sandbox.log"
SMOKE_MODE="${1:-}"

log() { echo "[sandbox-start] $*"; }
die() { echo "[sandbox-start] ERROR: $*" >&2; exit 1; }

# --- guards -----------------------------------------------------------------
[ -f "$SANDBOX_DIR/noa.db" ]              || die "Sandbox not set up. Run scripts/sandbox-setup.sh first."
[ -f "$SANDBOX_DIR/.dashboard-token" ]   || die "Sandbox token missing. Run scripts/sandbox-setup.sh first."
[ -f "$REPO/dist/index.js" ]             || die "dist/index.js missing -- run 'npm run build' first."

# --- build env block ---------------------------------------------------------
# NOA_BOOT_SMOKE is REQUIRED for the sandbox: it skips acquireLock()
# (which would SIGTERM the live dashboard on :3420) and starts db+web only.
# The sandbox is a dev/test tool, not a parallel production fleet.
SANDBOX_BOOT_ENV=(
  "SANDBOX_ISOLATION=1"
  "NOA_DB_PATH=$SANDBOX_DIR/noa.db"
  "WEB_PORT=$SANDBOX_PORT"
  "NOA_BOOT_SMOKE=$SANDBOX_PORT"
  "RESPAWN_ENABLED=false"
  # Clear all outbound channel tokens -- sandbox NEVER writes to live channels
  "TELEGRAM_BOT_TOKEN="
  "ALLOWED_CHAT_ID="
  "SLACK_BOT_TOKEN="
  "SLACK_APP_TOKEN="
  "SLACK_CHANNEL_ID="
  "DISCORD_BOT_TOKEN="
  "DISCORD_APP_ID="
  # Store the token path for the sandbox API calls
  "DASHBOARD_TOKEN_PATH=$SANDBOX_DIR/.dashboard-token"
)

if [ "$SMOKE_MODE" = "--smoke" ]; then
  log "Smoke mode requested (already default for sandbox)"
fi

# Build export string for tmux shell
ENV_EXPORTS=""
for kv in "${SANDBOX_BOOT_ENV[@]}"; do
  ENV_EXPORTS+="export ${kv}; "
done

# --- kill existing session --------------------------------------------------
if tmux has-session -t "=$SANDBOX_SESSION" 2>/dev/null; then
  log "Killing existing session $SANDBOX_SESSION..."
  tmux kill-session -t "=$SANDBOX_SESSION"
  sleep 1
fi

# --- start ------------------------------------------------------------------
log "Starting sandbox in tmux session '$SANDBOX_SESSION' (port $SANDBOX_PORT)..."
mkdir -p "$SANDBOX_DIR"
: > "$LOG"

tmux new-session -d -s "$SANDBOX_SESSION" \
  "cd '$REPO' && ${ENV_EXPORTS}node dist/index.js >> '$LOG' 2>&1"

# --- wait for startup --------------------------------------------------------
log "Waiting for sandbox to start (up to 30s)..."
SBX_TOKEN=$(cat "$SANDBOX_DIR/.dashboard-token")
for i in $(seq 1 30); do
  sleep 1
  if curl -sf -H "Authorization: Bearer $SBX_TOKEN" "http://127.0.0.1:$SANDBOX_PORT/api/auth/status" >/dev/null 2>&1; then
    log ""
    log "Sandbox UP on http://localhost:$SANDBOX_PORT"
    log "  Session : $SANDBOX_SESSION"
    log "  Port    : $SANDBOX_PORT"
    log "  DB      : $SANDBOX_DIR/noa.db"
    log "  Log     : $LOG"
    log ""
    log "Verify isolation: bash scripts/sandbox-isolation-test.sh"
    exit 0
  fi
  printf '.'
done

echo ""
die "Sandbox did not start within 30s. Check: $LOG"
