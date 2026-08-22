#!/bin/bash
# scripts/lib/ollama-local-guard.sh -- launch-time guard logic for the local
# Ollama agents (marveen-local / claudia-local, card ollama-hybrid).
#
# Sourced by the *-local-watchdog.sh scripts. Defines pure guard functions only
# (no daemon/tmux side effects on source) so the logic is unit-testable. See
# scripts/test_ollama_local_guard.sh.
#
# WHY a dedicated guard (not the generic agent-watchdog read_model): a local
# agent launches with ANTHROPIC_BASE_URL=http://localhost:11434. If the model
# silently falls back to a cloud model (claude-*), the launch either burns cloud
# tokens against a wrong endpoint or 404s into a dead session. So the guard is
# STRICT (no sonnet fallback) and DUAL-checked (negative: never cloud/empty;
# positive: must be an allowlisted Ollama model). Mirrors the FATAL dual-check in
# store/ollama-hybrid-spec-delta.md.

# Single source of truth for the accepted local-agent Ollama models. Substring
# matched against `ollama list` tag names (so qwen3:4b matches a quantised
# qwen3:4b-instruct-q4_k_m tag). Keep in sync with docs/ollama-vram-cookbook.md.
OLG_ALLOWED=("qwen3:4b" "qwen3:4b-instruct-q4_k_m" "qwen2.5:7b" "qwen3:8b")

# Restart thresholds (see spec-delta #2): adaptive context% takes priority, with
# a wall-clock fallback for when the dashboard API is unreachable.
OLG_CTX_RESTART_PCT=80      # restart when contextPercent strictly exceeds this
OLG_TIME_RESTART_SEC=28800  # 8h hard fallback restart

# olg_read_model <config_path>
# Prints the configured model and returns 0 on the happy path. On a missing /
# unparseable config, an absent model field, or an empty model, prints NOTHING
# and returns nonzero. NO default -- a local agent with an unknown model must
# not launch.
olg_read_model() {
  local cfg="$1" model
  model="$(python3 -c "import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    sys.exit(3)
m=d.get('model')
if not m:
    sys.exit(4)
print(m)" "$cfg" 2>/dev/null)" || return 1
  [ -n "$model" ] || return 1
  printf '%s\n' "$model"
}

# olg_model_allowed <model>
# Dual-check. Returns 0 only if the model is non-empty, is NOT a cloud model
# (claude-*) and is NOT the MISSING sentinel, AND matches the Ollama allowlist
# exactly. Returns nonzero (with a stderr reason) otherwise.
olg_model_allowed() {
  local model="$1" a
  if [ -z "$model" ] || [ "$model" = "MISSING" ]; then
    echo "olg_model_allowed: model is empty/MISSING -- local agent must not launch" >&2
    return 1
  fi
  case "$model" in
    claude-*)
      echo "olg_model_allowed: '$model' is a cloud model -- forbidden for a local Ollama agent" >&2
      return 1 ;;
  esac
  for a in "${OLG_ALLOWED[@]}"; do
    [ "$model" = "$a" ] && return 0
  done
  echo "olg_model_allowed: '$model' not in Ollama allowlist: ${OLG_ALLOWED[*]}" >&2
  return 1
}

# olg_tags_have_allowed <tags_json>
# Pure core of the Ollama health check. Given the JSON body of GET
# /api/tags, returns 0 iff at least one served model name contains an allowlisted
# model string (substring match, so quantised tags count). Returns nonzero on
# malformed JSON or no matching model.
olg_tags_have_allowed() {
  local json="$1"
  printf '%s' "$json" | python3 -c "
import json, sys
allowed = sys.argv[1:]
try:
    r = json.load(sys.stdin)
except Exception:
    sys.exit(1)
names = [m.get('name','') for m in r.get('models', [])]
sys.exit(0 if any(any(a in n for a in allowed) for n in names) else 1)
" "${OLG_ALLOWED[@]}" 2>/dev/null
}

# olg_ollama_ready [base_url]
# Live health check: GET /api/tags and confirm an allowlisted model is served.
# Returns nonzero if the daemon is unreachable or serves no allowlisted model.
olg_ollama_ready() {
  local base="${1:-http://localhost:11434}" body
  body="$(curl -sf --max-time 5 "$base/api/tags" 2>/dev/null)" || return 1
  olg_tags_have_allowed "$body"
}

# olg_should_restart <context_pct> <started_at_epoch> <now_epoch>
# Returns 0 (restart) when contextPercent strictly exceeds OLG_CTX_RESTART_PCT,
# OR when at least OLG_TIME_RESTART_SEC have elapsed since launch. A non-numeric
# context_pct (e.g. the API was unreachable and returned empty) is treated as 0
# so only the time fallback can fire -- it never crashes the watchdog loop.
olg_should_restart() {
  local ctx="$1" started="$2" now="$3"
  case "$ctx" in
    ''|*[!0-9]*) ctx=0 ;;
  esac
  [ "$ctx" -gt "$OLG_CTX_RESTART_PCT" ] && return 0
  [ $(( now - started )) -gt "$OLG_TIME_RESTART_SEC" ] && return 0
  return 1
}
