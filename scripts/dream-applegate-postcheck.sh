#!/usr/bin/env bash
# Deterministic post-check for the applegate weekly DREAM run. Writes a daily-log
# line stating whether today's dream output exists, so a skipped agent step is
# visible instead of silent. Exits 1 when the output is missing.
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DREAM_FILE="$REPO_ROOT/store/dreams/applegate-dream.md"
TOKEN_FILE="$REPO_ROOT/store/.dashboard-token"
TODAY="$(TZ=Europe/Budapest date +%F)"
NOW="$(TZ=Europe/Budapest date +%H:%M)"

if [ -f "$DREAM_FILE" ] && grep -q "^## $TODAY" "$DREAM_FILE"; then
  STATUS="OK"
  RC=0
else
  STATUS="MISSING output (no '## $TODAY' section in store/dreams/applegate-dream.md)"
  RC=1
fi

LINE="## $NOW -- DREAM post-check | $STATUS"
PAYLOAD="$(python3 -c 'import json, sys; print(json.dumps({"agent_id": "applegate", "content": sys.argv[1]}))' "$LINE")"

if [ ! -f "$TOKEN_FILE" ]; then
  echo "ERROR: dashboard token missing at $TOKEN_FILE" >&2
  exit 2
fi

printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_FILE")" | curl -s -f -K - \
  -X POST http://localhost:3420/api/daily-log \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/dev/null || {
    echo "ERROR: daily-log POST failed" >&2
    exit 2
  }

echo "$LINE"
exit "$RC"
