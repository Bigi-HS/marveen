#!/bin/bash
# scripts/lib/watchdog-common.sh -- shared helpers for the bash per-agent
# watchdogs under scripts/ (card 0b282eb0, A1 dedup). Sourced (never executed).
#
# Phase 1 extracts ONLY the read_model python-heredoc block (G1, ~390 LOC across
# 13 watchdogs) into a single wd_read_model. Nothing else (launch, under_cap,
# alert, config headers, crash-loop policy) is in this file yet -- those are
# Phase-2+ and are deliberately kept per-watchdog. Precedent for the pattern:
# scripts/lib/ollama-local-guard.sh (olg_read_model + test_ollama_local_guard.sh).
#
# ---------------------------------------------------------------------------
# ARCHETYPE / CONSTRAINT WARNING (migrated verbatim from dave-watchdog.sh:29-36,
# T8 -- so it is visible to every one of the callers that source this lib):
#
#   wd_read_model reads the EXPLICIT `model` field only. It does NOT know about
#   archetype-based resolution (PR#8 resolveAgentModelFromConfig). Today every
#   channel agent carries an explicit model, so the fallback below never fires --
#   but if a future archetype migration REMOVES the explicit model field, these
#   bash watchdogs would silently relaunch on the default model instead of the
#   archetype-resolved model. DO NOT drop the explicit `model` field from
#   agent-config.json while these bash watchdogs are in use, or teach
#   wd_read_model the archetype map first.
# ---------------------------------------------------------------------------
#
# set -u SAFETY (F4): every function here is safe under `set -u`. No reference to
# an unbound variable; all locals are initialised before use and every optional
# argument uses a `${x:-default}` guard.

# wd_read_model <agent-config.json> [default-model]
#
# Behaviour is byte-equivalent to the inline read_model() previously copied into
# thor/hibiki/bond (thor-watchdog.sh:24-46): prints the configured `.model` on
# the happy path; on a missing/unparseable config OR an absent `model` field it
# emits a LOUD warning (to $WD_LOG_FILE if set, AND to stderr) and then still
# prints the default model so the agent is never hard-stopped.
#
# The default is claude-sonnet-4-6 unless overridden by the 2nd argument.
#
# stdout: resolved model on happy path, else the default model.
# exit:   0 ok | 3 config missing/unparseable (warned) | 4 no/empty model field (warned).
#
# F7: the config PATH is passed to python via argv (sys.argv[1]), NEVER string-
# interpolated into the source, to remove the path-injection surface that
# open('$ACONF') carried.
wd_read_model() {
  local cfg="${1:-}"
  local default_model="${2:-claude-sonnet-4-6}"
  local model rc
  model="$(python3 -c "import json,sys
try:
    m=json.load(open(sys.argv[1])).get('model')
except Exception:
    sys.exit(3)
if not m:
    sys.exit(4)
print(m)" "$cfg" 2>/dev/null)"
  rc=$?
  case "$rc" in
    0)
      printf '%s\n' "$model"
      return 0
      ;;
    3)
      _wd_read_model_warn "WARN read_model: $cfg missing or unparseable -> defaulting to $default_model"
      printf '%s\n' "$default_model"
      return 3
      ;;
    *)
      _wd_read_model_warn "WARN read_model: $cfg has no 'model' field -> defaulting to $default_model"
      printf '%s\n' "$default_model"
      return 4
      ;;
  esac
}

# _wd_read_model_warn <msg>
# Internal LOUD-warn helper: mirrors the original inline block's "log + stderr"
# behaviour. Appends to $WD_LOG_FILE when the caller has set it (each watchdog
# already defines LOG=... and passes it as WD_LOG_FILE), and always writes to
# stderr. set -u safe: WD_LOG_FILE is read with a `${x:-}` guard.
_wd_read_model_warn() {
  local msg="${1:-}"
  local logfile="${WD_LOG_FILE:-}"
  if [ -n "$logfile" ]; then
    echo "$(date -Is) $msg" >> "$logfile" 2>/dev/null || true
  fi
  echo "$msg" >&2
}
