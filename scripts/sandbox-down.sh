#!/usr/bin/env bash
# sandbox-down.sh -- crash-safe, idempotent sandbox teardown (card 2efcb439).
#
# Spec: store/v2-spec-p9-sandbox-release.md §5 Teardown + three defense lines
# (DA-T0-3):
#   (a) Called by sandbox-up.sh's EXIT/ERR/SIGTERM trap.
#   (b) Can be run manually at any time, even if the sandbox is already gone.
#   (c) Called by the periodic stale-sandbox-sweep heartbeat.
#
# Three defense lines:
#   1. Kill all sb-<prefix>-* tmux sessions.
#   2. Remove the git worktree (git worktree remove --force).
#   3. WAL-checkpoint the sandbox DB (clean shutdown of SQLite WAL).
#
# Idempotent: every step is safe to run on an already-absent sandbox (no error).
#
# Usage:
#   scripts/sandbox-down.sh [record_file]
#
# If a record file is passed it is used to discover the sandbox parameters.
# Otherwise env vars are used (set by sandbox-up.sh or the pytest fixture).
#
# Env vars (read if record file not passed):
#   SANDBOX_WORKTREE          path to the sandbox git worktree
#   SANDBOX_SESSION_PREFIX    tmux session name prefix (e.g. sb-12345-1700000000)
#   SANDBOX_RECORD            path to the .sandbox-active-<id> record file (optional)
#   SANDBOX_LIVE_ROOT         live project root (for git worktree remove command)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_LIVE_ROOT="${SANDBOX_LIVE_ROOT:-$(dirname "$SCRIPT_DIR")}"

RECORD_FILE="${1:-${SANDBOX_RECORD:-}}"

log()  { printf '[sandbox-down] %s\n' "$*"; }
warn() { printf '[sandbox-down] WARN: %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Discover sandbox parameters from record file or env vars.
# ---------------------------------------------------------------------------
SANDBOX_WORKTREE="${SANDBOX_WORKTREE:-}"
SANDBOX_SESSION_PREFIX="${SANDBOX_SESSION_PREFIX:-}"

if [ -n "$RECORD_FILE" ] && [ -f "$RECORD_FILE" ]; then
    log "reading sandbox record: $RECORD_FILE"
    # Source key=value pairs from the record (safe: our own format).
    # shellcheck disable=SC1090
    while IFS='=' read -r key val; do
        case "$key" in
            sandbox_worktree)      SANDBOX_WORKTREE="$val" ;;
            sandbox_session_prefix) SANDBOX_SESSION_PREFIX="$val" ;;
        esac
    done < "$RECORD_FILE"
fi

if [ -z "$SANDBOX_WORKTREE" ] && [ -z "$SANDBOX_SESSION_PREFIX" ]; then
    log "no sandbox parameters found (SANDBOX_WORKTREE and SANDBOX_SESSION_PREFIX not set)"
    log "nothing to tear down -- exit 0 (idempotent)"
    exit 0
fi

log "teardown: worktree=$SANDBOX_WORKTREE  session_prefix=$SANDBOX_SESSION_PREFIX"

ERRORS=0

# ---------------------------------------------------------------------------
# Defense line 1: Kill all sb-<prefix>-* tmux sessions.
# ---------------------------------------------------------------------------
_kill_tmux_sessions() {
    local prefix="$1"
    if [ -z "$prefix" ]; then
        log "no session prefix -- skipping tmux kill"
        return
    fi

    if ! command -v tmux >/dev/null 2>&1; then
        log "tmux not found -- skipping session kill"
        return
    fi

    # List sessions whose names start with the prefix.
    local sessions
    sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null \
               | grep "^${prefix}" || true)

    if [ -z "$sessions" ]; then
        log "no tmux sessions matching '$prefix*' -- already clean"
        return
    fi

    while IFS= read -r session; do
        log "killing tmux session: $session"
        tmux kill-session -t "$session" 2>/dev/null || \
            warn "failed to kill session $session (may already be gone)"
    done <<< "$sessions"
}

_kill_tmux_sessions "$SANDBOX_SESSION_PREFIX" || ERRORS=$(( ERRORS + 1 ))

# ---------------------------------------------------------------------------
# Defense line 2: WAL-checkpoint the sandbox DB before removing the worktree.
# ---------------------------------------------------------------------------
_checkpoint_sandbox_db() {
    local worktree="$1"
    if [ -z "$worktree" ] || [ ! -d "$worktree" ]; then
        return
    fi
    local db="$worktree/store/noa.db"
    if [ ! -f "$db" ]; then
        return
    fi
    log "WAL-checkpoint sandbox DB: $db"
    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || \
            warn "sqlite3 wal_checkpoint failed on $db (non-fatal)"
    elif command -v node >/dev/null 2>&1; then
        node -e "
const D = require('better-sqlite3');
const d = new D('$db');
d.pragma('wal_checkpoint(TRUNCATE)');
d.close();
" 2>/dev/null || warn "node wal_checkpoint failed on $db (non-fatal)"
    else
        warn "neither sqlite3 nor node available -- skipping WAL checkpoint"
    fi
}

_checkpoint_sandbox_db "$SANDBOX_WORKTREE" || true

# ---------------------------------------------------------------------------
# Defense line 3: Remove the git worktree.
# ---------------------------------------------------------------------------
_remove_worktree() {
    local worktree="$1"
    if [ -z "$worktree" ]; then
        log "no worktree path -- skipping git worktree remove"
        return
    fi
    if [ ! -d "$worktree" ]; then
        log "worktree already removed: $worktree"
        return
    fi
    log "removing git worktree: $worktree"
    git -C "$SANDBOX_LIVE_ROOT" worktree remove --force "$worktree" 2>/dev/null || {
        warn "git worktree remove failed for $worktree -- falling back to rm -rf"
        rm -rf "$worktree" 2>/dev/null || \
            warn "rm -rf $worktree also failed (non-fatal, may need manual cleanup)"
    }
    log "worktree removed"
}

_remove_worktree "$SANDBOX_WORKTREE" || ERRORS=$(( ERRORS + 1 ))

# ---------------------------------------------------------------------------
# Clean up the record file.
# ---------------------------------------------------------------------------
if [ -n "$RECORD_FILE" ] && [ -f "$RECORD_FILE" ]; then
    rm -f "$RECORD_FILE" 2>/dev/null || \
        warn "failed to remove record file $RECORD_FILE (non-fatal)"
    log "removed record file: $RECORD_FILE"
fi

# ---------------------------------------------------------------------------
# Release the sandbox lock (if we still hold it).
# ---------------------------------------------------------------------------
LOCK_FILE="$SANDBOX_LIVE_ROOT/store/.sandbox.lock"
if [ -f "$LOCK_FILE" ]; then
    # Only remove it if it is not held by another process (flock check).
    if flock -n "$LOCK_FILE" true 2>/dev/null; then
        rm -f "$LOCK_FILE" 2>/dev/null || true
        log "released sandbox lock"
    else
        log "sandbox lock is held by another process -- not removing"
    fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [ "$ERRORS" -gt 0 ]; then
    warn "teardown completed with $ERRORS non-fatal error(s) -- sandbox may need manual cleanup"
    exit 0  # Still exit 0: teardown errors are non-fatal (idempotent contract)
fi

log "teardown complete -- all sandbox resources cleaned up"
exit 0
