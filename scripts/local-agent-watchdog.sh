#!/bin/bash
# Watchdog for a LOCAL-OLLAMA fleet sub-agent (marveen-local / claudia-local,
# card ollama-hybrid). Usage: local-agent-watchdog.sh <name>
#
# These agents run a local Ollama model (qwen3:4b) instead of a cloud Claude
# model. They are channel-less and zero-token: they poll hot-memory for QUEUE:
# items, handle the trivial/local ones, and leave judgment/orchestration for the
# cloud agent. Differences from the generic agent-watchdog.sh:
#
#   1. FATAL DUAL-CHECK (no sonnet fallback). A cloud model on the Ollama
#      endpoint is a dead/token-burning agent, so the model is read strictly and
#      dual-checked (negative: never cloud/empty; positive: allowlisted Ollama
#      model). On failure the watchdog exits 1 rather than launching.
#   2. PRE-LAUNCH OLLAMA HEALTH CHECK. No Claude session is started until the
#      Ollama daemon serves an allowlisted model (5 retries / 30s).
#   3. OLLAMA LAUNCH ENV. ANTHROPIC_AUTH_TOKEN=ollama +
#      ANTHROPIC_BASE_URL=http://localhost:11434, isolated CLAUDE_CONFIG_DIR. NO
#      cloud OAuth env, NO --channels, NO --continue (short-context model, fresh
#      session each launch; durable state lives in the memory system).
#   4. ADAPTIVE CONTEXT-SATURATION RESTART. While the session is alive the
#      watchdog polls the dashboard contextPercent and restarts when it exceeds
#      the threshold, with an 8h wall-clock fallback.
#
# Guard logic lives in scripts/lib/ollama-local-guard.sh (unit-tested by
# scripts/test_ollama_local_guard.sh).

set -u
NAME="${1:-}"
[ -z "$NAME" ] && echo "usage: local-agent-watchdog.sh <name>" >&2 && exit 2

ROOT="/home/domin/marveen"
SESSION="agent-$NAME"
AGENT_DIR="$ROOT/agents/$NAME"
CFG="$AGENT_DIR/.claude-config"
ACONF="$AGENT_DIR/agent-config.json"
LOG="$ROOT/store/${NAME}-watchdog.log"
TOKEN_FILE="$ROOT/store/.dashboard-token"
OLLAMA_BASE="http://localhost:11434"
COOLDOWN=60
MAX_PER_HOUR=8
HEALTH_RETRIES=5
HEALTH_INTERVAL=6     # 5 retries * 6s = 30s
CTX_POLL_SEC=120      # how often to re-check context-saturation while alive

log() { echo "$(date -Is) $*" >> "$LOG"; }

# shellcheck disable=SC1091
. "$ROOT/scripts/lib/ollama-local-guard.sh"

# Fetch the agent's contextPercent from the dashboard. Prints a number (0 if the
# API is unreachable or the agent is absent) so olg_should_restart can decide.
read_context_pct() {
  local tok=""
  [ -f "$TOKEN_FILE" ] && tok="$(cat "$TOKEN_FILE" 2>/dev/null)"
  curl -sf --max-time 5 "http://localhost:3420/api/agents" \
    -H "Authorization: Bearer $tok" 2>/dev/null \
  | python3 -c "
import json, sys
try:
    a = json.load(sys.stdin)
except Exception:
    print(0); sys.exit(0)
agents = a if isinstance(a, list) else a.get('agents', [])
for x in agents:
    if x.get('id') == '$NAME':
        print(x.get('contextPercent', 0) or 0); break
else:
    print(0)
" 2>/dev/null || echo 0
}

# Block until Ollama serves an allowlisted model, or give up after the retry
# budget. Returns 0 if ready, 1 otherwise.
wait_for_ollama() {
  local i
  for i in $(seq 1 "$HEALTH_RETRIES"); do
    if olg_ollama_ready "$OLLAMA_BASE"; then
      log "ollama ready (allowlisted model served) on attempt $i"
      return 0
    fi
    log "ollama not ready (attempt $i/$HEALTH_RETRIES) -- retrying in ${HEALTH_INTERVAL}s"
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

STARTED_AT=0

launch() {
  # FATAL dual-check: strict model read + allowlist. Never fall back to a cloud
  # model on the Ollama endpoint.
  local model
  if ! model="$(olg_read_model "$ACONF")"; then
    log "FATAL: $ACONF missing/unparseable or no model field -- local agent will NOT launch"
    exit 1
  fi
  if ! olg_model_allowed "$model" 2>>"$LOG"; then
    log "FATAL: model '$model' failed the dual-check -- local agent will NOT launch"
    exit 1
  fi

  # Pre-launch Ollama health check.
  if ! wait_for_ollama; then
    log "ollama not ready after ${HEALTH_RETRIES} attempts -- skipping launch this cycle"
    return 1
  fi

  # Ollama launch env. No cloud OAuth, no --channels, no --continue.
  tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true
  local cmd="export PATH=\"\$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" \
&& unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN CLAUDE_CODE_OAUTH_TOKEN \
&& export ANTHROPIC_AUTH_TOKEN=ollama \
&& export ANTHROPIC_BASE_URL=$OLLAMA_BASE \
&& export CLAUDE_CONFIG_DIR=\"$CFG\" \
&& cd \"$AGENT_DIR\" \
&& /usr/bin/claude --dangerously-skip-permissions --model '$model'"
  tmux new-session -d -s "$SESSION" "$cmd"
  STARTED_AT=$(date +%s)
  log "launched $SESSION (local Ollama, model=$model, base=$OLLAMA_BASE, no --channels/--continue)"
  return 0
}

log "local-agent-watchdog started for $SESSION (pid $$)"

declare -a STAMPS=()
under_cap() {
  local now; now=$(date +%s); local kept=(); local s
  for s in "${STAMPS[@]}"; do [ $((now - s)) -lt 3600 ] && kept+=("$s"); done
  STAMPS=("${kept[@]}"); [ "${#STAMPS[@]}" -lt "$MAX_PER_HOUR" ]
}

while true; do
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    if under_cap; then
      log "$SESSION DOWN -- cooldown ${COOLDOWN}s then relaunch"
      sleep "$COOLDOWN"
      STAMPS+=("$(date +%s)")
      launch || true
    else
      log "$SESSION DOWN but relaunch cap (${MAX_PER_HOUR}/h) reached -- backing off 600s"
      sleep 600
    fi
  else
    # Alive: adaptive context-saturation check.
    pct="$(read_context_pct)"
    if olg_should_restart "$pct" "$STARTED_AT" "$(date +%s)"; then
      log "$SESSION context-saturation restart (ctx=${pct}%, started ${STARTED_AT}) -- killing for fresh relaunch"
      tmux kill-session -t "$SESSION" 2>/dev/null || true
    fi
  fi
  sleep "$CTX_POLL_SEC"
done
