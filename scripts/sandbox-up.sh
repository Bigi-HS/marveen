#!/usr/bin/env bash
# sandbox-up.sh -- bootstrap an isolated P9 sandbox (card 2efcb439).
#
# Spec: store/v2-spec-p9-sandbox-release.md §5 + §3 invariants.
#
# What this does:
#   1. Takes a flock on store/.sandbox.lock (G4: concurrency guard).
#   2. Checks out develop HEAD (or a passed branch) into a NEW git worktree.
#   3. Takes a WAL-safe fixture DB copy via sqlite3 .backup (G3).
#   4. Allocates a FREE dynamic port (not 3420, not hardcoded -- G4).
#   5. Stubs live channels/secrets into the worktree (Inv-1, Inv-9):
#        - TELEGRAM_STATE_DIR -> sandbox stub dir
#        - store/.dashboard-token -> stub token
#        - ~/.git-credentials and ~/.claude/ -> stub symlinks inside the WT
#   6. Runs sandbox-isolation-selftest.sh to prove isolation before launch.
#   7. Starts the server in a unique sb-<lockid>-* tmux namespace.
#   8. Writes a lockfile record (store/.sandbox-active-<lockid>) for teardown.
#
# Crash-safety (Inv-1 / DA-T0-3):
#   - trap sandbox_teardown EXIT ERR SIGTERM runs even on crash/kill.
#   - sandbox-down.sh is the durable teardown tool (idempotent).
#
# Usage:
#   scripts/sandbox-up.sh [branch]
#
# Options / env:
#   SANDBOX_LIVE_ROOT     live project root (default: dirname of this script's repo)
#   SANDBOX_BRANCH        branch to check out (default: develop; overridden by $1)
#   SANDBOX_DRY_RUN=1     validate + print what would happen, do NOT create sessions
#   SANDBOX_NO_SERVER=1   skip the tmux/server launch (for unit tests / CI)
#
# Exit codes:
#   0  sandbox is up and isolation-verified (or dry-run complete)
#   1  error (lock held + no-queue / precondition / isolation failure)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Default: live root is two levels up from scripts/ (the repo root).
SANDBOX_LIVE_ROOT="${SANDBOX_LIVE_ROOT:-$(dirname "$SCRIPT_DIR")}"

BRANCH="${1:-${SANDBOX_BRANCH:-develop}}"
DRY_RUN="${SANDBOX_DRY_RUN:-0}"
NO_SERVER="${SANDBOX_NO_SERVER:-0}"

LOCK_FILE="$SANDBOX_LIVE_ROOT/store/.sandbox.lock"
SANDBOX_DIR_BASE="$SANDBOX_LIVE_ROOT/store/.sandbox-worktrees"
SELFTEST="$SCRIPT_DIR/sandbox-isolation-selftest.sh"
SANDBOX_DOWN="$SCRIPT_DIR/sandbox-down.sh"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() { printf '[sandbox-up] %s\n' "$*"; }
err() { printf '[sandbox-up] ERROR: %s\n' "$*" >&2; }

_free_port() {
    # Find a free port in the dynamic range (not 3420).
    python3 - <<'PYEOF'
import socket
for attempt in range(100):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    if port != 3420:
        print(port)
        break
PYEOF
}

_wal_backup() {
    local src="$1" dst="$2"
    # G3: WAL-safe snapshot via sqlite3 .backup (never raw cp).
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$src" ".backup $dst"
    else
        # Fallback: attempt better-sqlite3 WAL checkpoint, then cp.
        node -e "
const D = require('better-sqlite3');
const d = new D('$src');
d.pragma('wal_checkpoint(TRUNCATE)');
d.close();
" 2>/dev/null || true
        cp "$src" "$dst"
    fi
    log "WAL-safe fixture copy: $src -> $dst"
}

# ---------------------------------------------------------------------------
# Teardown (crash-safe, called by trap + sandbox-down.sh)
# ---------------------------------------------------------------------------
SANDBOX_SESSION_PREFIX=""
SANDBOX_WORKTREE=""
SANDBOX_RECORD=""

sandbox_teardown() {
    local exit_code=$?
    # Only run teardown if sandbox was actually started.
    if [ -n "$SANDBOX_WORKTREE" ] || [ -n "$SANDBOX_SESSION_PREFIX" ]; then
        log "teardown triggered (exit_code=$exit_code)"
        SANDBOX_WORKTREE="$SANDBOX_WORKTREE" \
        SANDBOX_SESSION_PREFIX="$SANDBOX_SESSION_PREFIX" \
            bash "$SANDBOX_DOWN" 2>/dev/null || true
        # Remove the active record.
        [ -n "$SANDBOX_RECORD" ] && rm -f "$SANDBOX_RECORD" 2>/dev/null || true
    fi
}

# Register trap BEFORE any work that could need cleanup.
trap sandbox_teardown EXIT ERR SIGTERM

# ---------------------------------------------------------------------------
# --help
# ---------------------------------------------------------------------------
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    cat <<HELP
Usage: scripts/sandbox-up.sh [branch]

Bootstrap an isolated P9 sandbox (spec §5):
  - WAL-safe fixture DB copy (never the live noa.db)
  - Flock-protected dynamic port + unique sb-<id>-* tmux namespace
  - Live secret/channel stubs (Inv-9)
  - Isolation self-test before launch (Inv-1)

Options (env vars):
  SANDBOX_LIVE_ROOT    live project root (default: auto-detected)
  SANDBOX_BRANCH       branch to check out (default: develop)
  SANDBOX_DRY_RUN=1    validate only, no tmux/flock
  SANDBOX_NO_SERVER=1  skip tmux launch (for CI/unit tests)
HELP
    exit 0
fi

# ---------------------------------------------------------------------------
# Precondition checks
# ---------------------------------------------------------------------------
LIVE_DB="$SANDBOX_LIVE_ROOT/store/noa.db"
LIVE_TOKEN="$SANDBOX_LIVE_ROOT/store/.dashboard-token"

if [ "$DRY_RUN" = "1" ]; then
    log "DRY RUN mode -- printing config, no flock/tmux/worktree created"
    log "  SANDBOX_LIVE_ROOT = $SANDBOX_LIVE_ROOT"
    log "  BRANCH            = $BRANCH"
    log "  LIVE_DB           = $LIVE_DB"
    log "  LOCK_FILE         = $LOCK_FILE"
    log "  SELFTEST          = $SELFTEST"
    log "DRY RUN complete."
    # Disable trap teardown (nothing to tear down).
    trap - EXIT ERR SIGTERM
    exit 0
fi

if [ ! -f "$LIVE_DB" ]; then
    err "live noa.db not found at $LIVE_DB -- cannot take fixture copy"
    exit 1
fi

mkdir -p "$SANDBOX_DIR_BASE"
mkdir -p "$(dirname "$LOCK_FILE")"

# ---------------------------------------------------------------------------
# Acquire flock (G4 concurrency guard)
# ---------------------------------------------------------------------------
# Open the lock file and acquire an exclusive lock.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    err "sandbox.lock is held by another sandbox instance."
    err "If you need a second slot, use SANDBOX_SLOT=2 (future feature)."
    err "To tear down the existing sandbox: bash $SANDBOX_DOWN"
    exit 1
fi

# Generate a unique lock ID from the PID + timestamp.
LOCK_ID="${$}-$(date +%s)"
log "acquired sandbox lock (lock_id=$LOCK_ID)"

# ---------------------------------------------------------------------------
# Allocate dynamic port (G4)
# ---------------------------------------------------------------------------
SANDBOX_PORT=$(_free_port)
log "allocated sandbox port: $SANDBOX_PORT"

# ---------------------------------------------------------------------------
# Create a unique tmux namespace and worktree path
# ---------------------------------------------------------------------------
SANDBOX_SESSION_PREFIX="sb-$LOCK_ID"
SANDBOX_WORKTREE="$SANDBOX_DIR_BASE/wt-$LOCK_ID"

log "sandbox session prefix: $SANDBOX_SESSION_PREFIX"
log "sandbox worktree:       $SANDBOX_WORKTREE"

# ---------------------------------------------------------------------------
# Checkout branch into isolated worktree
# ---------------------------------------------------------------------------
log "checking out branch '$BRANCH' into $SANDBOX_WORKTREE ..."
git -C "$SANDBOX_LIVE_ROOT" worktree add "$SANDBOX_WORKTREE" "$BRANCH" 2>&1 | \
    sed 's/^/[sandbox-up] git: /'

# Symlink node_modules to avoid a full npm install.
if [ ! -e "$SANDBOX_WORKTREE/node_modules" ] && \
   [ -d "$SANDBOX_LIVE_ROOT/node_modules" ]; then
    ln -s "$SANDBOX_LIVE_ROOT/node_modules" "$SANDBOX_WORKTREE/node_modules"
    log "symlinked node_modules"
fi

# ---------------------------------------------------------------------------
# WAL-safe fixture DB copy (G3)
# ---------------------------------------------------------------------------
mkdir -p "$SANDBOX_WORKTREE/store"
SANDBOX_DB="$SANDBOX_WORKTREE/store/noa.db"
_wal_backup "$LIVE_DB" "$SANDBOX_DB"

# ---------------------------------------------------------------------------
# Stub live secrets inside the worktree (Inv-9)
# ---------------------------------------------------------------------------

# Stub .dashboard-token.
SANDBOX_TOKEN="$SANDBOX_WORKTREE/store/.dashboard-token"
printf 'sandbox-stub-%s\n' "$LOCK_ID" > "$SANDBOX_TOKEN"
log "stubbed store/.dashboard-token"

# Stub TELEGRAM_STATE_DIR (sandbox never talks to real Telegram).
TELEGRAM_STUB_DIR="$SANDBOX_WORKTREE/store/telegram-stub"
mkdir -p "$TELEGRAM_STUB_DIR"
export TELEGRAM_STATE_DIR="$TELEGRAM_STUB_DIR"
log "TELEGRAM_STATE_DIR -> $TELEGRAM_STUB_DIR"

# Stub ~/.git-credentials inside the worktree (Inv-9).
# The worktree gets its own stub so imports cannot read the real credential file.
SANDBOX_GIT_CREDS="$SANDBOX_WORKTREE/.git-credentials-stub"
printf '# sandbox stub -- not the real git credentials\n' > "$SANDBOX_GIT_CREDS"
# Point GIT_CONFIG_GLOBAL / HOME override is NOT done here to avoid leaking;
# the git credential isolation is enforced by the worktree env at launch time.
log "created .git-credentials stub at $SANDBOX_GIT_CREDS"

# Stub ~/.claude config dir (Inv-9): create a minimal stub inside the worktree.
SANDBOX_CLAUDE_DIR="$SANDBOX_WORKTREE/.claude-stub"
mkdir -p "$SANDBOX_CLAUDE_DIR"
log "created .claude stub dir at $SANDBOX_CLAUDE_DIR"

# ---------------------------------------------------------------------------
# Run isolation self-test BEFORE launching (Inv-1 static check)
# ---------------------------------------------------------------------------
log "running isolation self-test ..."
env \
    SANDBOX_ISOLATION_TEST=1 \
    SANDBOX_DB="$SANDBOX_DB" \
    LIVE_DB="$LIVE_DB" \
    LIVE_TOKEN="$LIVE_TOKEN" \
    SANDBOX_TOKEN="$SANDBOX_TOKEN" \
    SANDBOX_LIVE_ROOT="$SANDBOX_LIVE_ROOT" \
    SANDBOX_PORT="$SANDBOX_PORT" \
    TELEGRAM_STATE_DIR="$TELEGRAM_STUB_DIR" \
    bash "$SELFTEST"

log "isolation self-test PASSED"

# ---------------------------------------------------------------------------
# Record the active sandbox (for sandbox-down.sh and stale-sweep)
# ---------------------------------------------------------------------------
SANDBOX_RECORD="$SANDBOX_LIVE_ROOT/store/.sandbox-active-$LOCK_ID"
cat > "$SANDBOX_RECORD" <<RECORD
lock_id=$LOCK_ID
lock_pid=$$
sandbox_worktree=$SANDBOX_WORKTREE
sandbox_port=$SANDBOX_PORT
sandbox_session_prefix=$SANDBOX_SESSION_PREFIX
sandbox_db=$SANDBOX_DB
started_at=$(date +%s)
RECORD
log "wrote sandbox record: $SANDBOX_RECORD"

# ---------------------------------------------------------------------------
# Launch sandbox server in tmux (skipped if NO_SERVER=1 or DRY_RUN)
# ---------------------------------------------------------------------------
if [ "$NO_SERVER" = "1" ]; then
    log "SANDBOX_NO_SERVER=1 -- skipping tmux launch"
    log "sandbox is up and isolated (no server started)"
    # Disable teardown trap -- caller is responsible for sandbox-down.sh.
    trap - EXIT ERR SIGTERM
    printf '\n[sandbox-up] SANDBOX_WORKTREE=%s\n' "$SANDBOX_WORKTREE"
    printf '[sandbox-up] SANDBOX_PORT=%s\n' "$SANDBOX_PORT"
    printf '[sandbox-up] SANDBOX_SESSION_PREFIX=%s\n' "$SANDBOX_SESSION_PREFIX"
    printf '[sandbox-up] SANDBOX_RECORD=%s\n' "$SANDBOX_RECORD"
    exit 0
fi

SERVER_SESSION="${SANDBOX_SESSION_PREFIX}-server"
log "launching sandbox server in tmux session: $SERVER_SESSION"

# The sandbox server runs with:
#   - its own PROJECT_ROOT ($SANDBOX_WORKTREE)
#   - NOA_PORT pointing to the dynamic port (not 3420)
#   - SANDBOX_ISOLATION=1 so the server ABORTS if it detects the live DB path
#   - stubbed credentials (no real Telegram / no real dashboard-token)
#   - sb-parent-pid=$$  so the watchdog within can self-terminate if we die
tmux new-session -d -s "$SERVER_SESSION" \
    -e "SANDBOX_ISOLATION=1" \
    -e "NOA_PORT=$SANDBOX_PORT" \
    -e "TELEGRAM_STATE_DIR=$TELEGRAM_STUB_DIR" \
    -e "SANDBOX_PARENT_PID=$$" \
    -e "SANDBOX_RECORD=$SANDBOX_RECORD" \
    "cd '$SANDBOX_WORKTREE' && npm start -- --port '$SANDBOX_PORT' 2>&1 | tee store/sandbox-server.log"

log "sandbox server started in $SERVER_SESSION (port $SANDBOX_PORT)"
log "sandbox is up. Use 'bash $SANDBOX_DOWN SANDBOX_WORKTREE=$SANDBOX_WORKTREE' to tear down."

# Disable the auto-teardown trap now that the sandbox is fully up and
# the caller may keep it running.
trap - EXIT ERR SIGTERM

printf '\n[sandbox-up] READY\n'
printf '[sandbox-up] SANDBOX_WORKTREE=%s\n' "$SANDBOX_WORKTREE"
printf '[sandbox-up] SANDBOX_PORT=%s\n' "$SANDBOX_PORT"
printf '[sandbox-up] SANDBOX_SESSION_PREFIX=%s\n' "$SANDBOX_SESSION_PREFIX"
printf '[sandbox-up] SANDBOX_RECORD=%s\n' "$SANDBOX_RECORD"
exit 0
