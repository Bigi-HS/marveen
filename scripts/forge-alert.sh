#!/bin/bash
# forge-alert.sh -- send a forge alert to marveen via /api/messages.
# On API failure, buffer the alert to the local escalation queue so
# fleet-supervisor can forward it when the dashboard recovers.
#
# Usage: forge-alert.sh "<content>" [<type>]
#   content : alert message text
#   type    : event type tag (default: "alert")
#
# Environment overrides (for testing):
#   QUEUE_FILE : path to the JSONL queue (default: store/forge-escalation-queue.jsonl)
#   CURL_BIN   : curl binary to use (default: curl)
#   DASH_PORT  : dashboard port (default: 3420)
#   TOKEN_FILE : path to dashboard token (default: store/.dashboard-token)
set -u

CONTENT="${1:-}"
TYPE="${2:-alert}"

[ -z "$CONTENT" ] && { echo "forge-alert.sh: content required" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

QUEUE_FILE="${QUEUE_FILE:-$REPO_ROOT/store/forge-escalation-queue.jsonl}"
CURL_BIN="${CURL_BIN:-curl}"
DASH_PORT="${DASH_PORT:-3420}"
TOKEN_FILE="${TOKEN_FILE:-$REPO_ROOT/store/.dashboard-token}"
QUEUE_MAX_ENTRIES=50

# Build JSON payload via python3 (avoid quote-injection).
build_payload() {
    python3 -c "
import json, sys
print(json.dumps({'from': 'forge', 'to': 'marveen', 'content': sys.argv[1]}))
" "$CONTENT" 2>/dev/null
}

# Attempt to deliver via dashboard API.
deliver() {
    local token
    token=$(python3 -c "
import sys
print(open(sys.argv[1]).read().strip())
" "$TOKEN_FILE" 2>/dev/null) || return 1
    local payload
    payload=$(build_payload) || return 1
    "$CURL_BIN" -sf -m 5 -X POST \
        "http://127.0.0.1:${DASH_PORT}/api/messages" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $token" \
        -d "$payload" >/dev/null 2>&1
}

# Append to local buffer (0600, capped at QUEUE_MAX_ENTRIES).
buffer_alert() {
    local entry
    entry=$(python3 -c "
import json, sys, datetime
print(json.dumps({
    'ts': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
    'from': 'forge',
    'content': sys.argv[1],
    'type': sys.argv[2],
}))
" "$CONTENT" "$TYPE" 2>/dev/null) || return 1

    # Create file with 0600 if it doesn't exist.
    if [ ! -f "$QUEUE_FILE" ]; then
        (umask 177 && : > "$QUEUE_FILE") || return 1
    fi

    # Append with flock, then cap to QUEUE_MAX_ENTRIES (drop oldest).
    (
        flock -x 9
        echo "$entry" >> "$QUEUE_FILE"
        # Cap: keep only the last QUEUE_MAX_ENTRIES lines.
        local lines
        lines=$(wc -l < "$QUEUE_FILE")
        if [ "$lines" -gt "$QUEUE_MAX_ENTRIES" ]; then
            local excess=$(( lines - QUEUE_MAX_ENTRIES ))
            tmp=$(mktemp)
            tail -n +"$((excess + 1))" "$QUEUE_FILE" > "$tmp" && mv "$tmp" "$QUEUE_FILE"
            chmod 0600 "$QUEUE_FILE"
        fi
    ) 9>>"$QUEUE_FILE".lock 2>/dev/null
}

if deliver; then
    exit 0
fi

# Delivery failed -- buffer locally.
buffer_alert
exit 0
