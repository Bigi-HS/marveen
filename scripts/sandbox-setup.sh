#!/usr/bin/env bash
# P9 sandbox setup (card p9-sandbox-foundation).
#
# One-time (or re-sync) script: creates store/sandbox/ with an isolated noa.db
# copy + a fresh dashboard token. Safe to re-run -- it overwrites the sandbox
# DB with a fresh copy of live and rotates the token.
#
# Usage:
#   bash scripts/sandbox-setup.sh
#   bash scripts/sandbox-setup.sh --resync   # same: force fresh DB copy
#
# Output:
#   store/sandbox/noa.db          -- isolated copy of live noa.db
#   store/sandbox/.dashboard-token -- sandbox API token (not shared with live)
#   store/sandbox/identity        -- sandbox marker (read by isolation-test)
#
# After setup, start the sandbox with: bash scripts/sandbox-start.sh
# Verify isolation with:              bash scripts/sandbox-isolation-test.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX_DIR="$REPO/store/sandbox"
LIVE_DB="$REPO/store/noa.db"
SANDBOX_DB="$SANDBOX_DIR/noa.db"

log() { echo "[sandbox-setup] $*"; }
die() { echo "[sandbox-setup] ERROR: $*" >&2; exit 1; }

# --- guards -----------------------------------------------------------------
[ -f "$REPO/dist/index.js" ] || die "dist/index.js missing -- run 'npm run build' first"
[ -f "$LIVE_DB" ] || die "store/noa.db missing -- cannot copy"

# --- create dirs ------------------------------------------------------------
mkdir -p "$SANDBOX_DIR"

# --- checkpoint WAL so the copy is a clean, complete snapshot ---------------
log "Checkpointing live noa.db WAL..."
node -e "
const D = require('better-sqlite3');
const d = new D('$LIVE_DB');
d.pragma('wal_checkpoint(TRUNCATE)');
d.close();
console.log('WAL checkpoint OK');
" 2>/dev/null || log "WARN: WAL checkpoint failed (not fatal -- copy may be slightly behind)"

# --- copy noa.db ------------------------------------------------------------
log "Copying noa.db -> sandbox..."
cp "$LIVE_DB" "$SANDBOX_DB"
chmod 600 "$SANDBOX_DB"
log "noa.db copied ($(du -h "$SANDBOX_DB" | cut -f1))"

# --- generate sandbox token (never the live token) --------------------------
TOKEN="sandbox-$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 28)"
printf '%s' "$TOKEN" > "$SANDBOX_DIR/.dashboard-token"
chmod 600 "$SANDBOX_DIR/.dashboard-token"
log "Dashboard token generated"

# --- write identity marker --------------------------------------------------
printf 'P9_SANDBOX=1\nSANDBOX_PORTS=3430/3431\nSANDBOX_CREATED=%s\nLIVE_DB_AT_COPY=%s\n' \
  "$(date -Iseconds)" "$LIVE_DB" > "$SANDBOX_DIR/identity"
log "Identity marker written"

# --- summary ----------------------------------------------------------------
log ""
log "Setup complete."
log "  Sandbox DB :  $SANDBOX_DB"
log "  Token      :  $SANDBOX_DIR/.dashboard-token"
log "  Ports      :  3430 (dashboard)  3431 (reserved)"
log ""
log "Next steps:"
log "  Start  : bash scripts/sandbox-start.sh"
log "  Verify : bash scripts/sandbox-isolation-test.sh"
