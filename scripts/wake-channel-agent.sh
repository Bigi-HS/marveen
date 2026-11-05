#!/bin/bash
# wake-channel-agent.sh <agent-name>
#
# One-shot wake for a sleeping channel agent. Called by the n8n wake-on-DM
# workflow when a Boss DM arrives for a sleeping agent. Idempotent: if the
# agent session is already alive, exits 0 immediately. NOT a daemon loop --
# the agent's own watchdog handles respawn/keepalive once the agent is up.
#
# SECURITY: agent-name is validated against a hard-coded allowlist. It must
# NEVER be derived from message content (command/pattern injection defence).
#
# Usage: bash scripts/wake-channel-agent.sh <agent-name>
# Exit codes: 0=ok/noop  1=rejected/error  2=watchdog-missing

set -euo pipefail

INSTALL_DIR="/home/domin/marveen"
STORE="$INSTALL_DIR/store"
LOG="$STORE/wake-on-dm.log"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [wake-channel-agent] $*" | tee -a "$LOG" >&2; }

AGENT_NAME="${1:-}"

# SECURITY GATE: allowlist -- never accept agent-name from untrusted input.
# Mirrors the channel-agent set in fleet-supervisor ensure_channel_watchdogs.
# gelim/inkwell excluded until they have watchdog scripts (card 3d36c13a).
ALLOWED="forge chad thor claudia bigben hibiki devil-advocate bond scout gyore percy buster blackbart servo-skull"

valid=0
for a in $ALLOWED; do
  [ "$AGENT_NAME" = "$a" ] && valid=1 && break
done

if [ "$valid" -eq 0 ]; then
  log "REJECTED: '$AGENT_NAME' is not in the channel-agent allowlist"
  exit 1
fi

SESSION="agent-${AGENT_NAME}"
WATCHDOG_SCRIPT="$INSTALL_DIR/scripts/${AGENT_NAME}-watchdog.sh"

# Idempotent: agent session already alive -- nothing to do.
if tmux has-session -t "=$SESSION" 2>/dev/null; then
  log "NOOP: $SESSION already alive"
  exit 0
fi

# Verify per-agent watchdog script exists (guards against a misconfigured call).
if [ ! -x "$WATCHDOG_SCRIPT" ]; then
  log "ERROR: $WATCHDOG_SCRIPT not found or not executable -- cannot wake $AGENT_NAME"
  exit 2
fi

log "WAKE: $AGENT_NAME -- spawning one-shot channel launch"

# Derive standard per-agent path variables (consistent across all channel agents).
AGENT_DIR="$INSTALL_DIR/agents/${AGENT_NAME}"
CFG="$AGENT_DIR/.claude-config"
STATE="$AGENT_DIR/.claude/channels/telegram"
ACONF="$AGENT_DIR/agent-config.json"

# Read model from agent-config.json (mirrors wd_read_model pattern).
model="claude-sonnet-4-6"
if [ -f "$ACONF" ]; then
  _m="$(python3 -c "import json,sys; d=json.load(open('$ACONF')); print(d.get('model',''))" 2>/dev/null || true)"
  [ -n "$_m" ] && model="$_m"
fi

# Scrub any inherited TMUX env (mirrors channels.sh / hibiki-watchdog.sh).
unset TMUX 2>/dev/null || true
command -v tmux >/dev/null 2>&1 && tmux set-environment -g -u TELEGRAM_BOT_TOKEN 2>/dev/null || true

# Build and spawn the channel session (one-shot, NOT a daemon loop).
# Pattern mirrors hibiki-watchdog.sh launch() exactly.
cmd="export PATH=\"\$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:\$PATH\" \
  && unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN \
  && export CLAUDE_CONFIG_DIR=\"$CFG\" \
  && export TELEGRAM_STATE_DIR=\"$STATE\" \
  && cd \"$AGENT_DIR\" \
  && export FLEET_ROOT=$INSTALL_DIR \
  && . $INSTALL_DIR/scripts/lib/fleet-oauth-env.sh \
  && /usr/bin/claude --dangerously-skip-permissions --model '$model' \
     --channels plugin:telegram@claude-plugins-official"

tmux new-session -d -s "$SESSION" "$cmd"
log "session $SESSION started (model=$model)"

# First-run dialog guard: auto-accept Bypass/trust prompts (mirrors hibiki-watchdog.sh).
for i in $(seq 1 20); do
  sleep 1
  pane="$(tmux capture-pane -t "=$SESSION:" -p 2>/dev/null || true)"
  case "$pane" in
    *"Bypass Permissions mode"*"Yes, I accept"*) tmux send-keys -t "=$SESSION:" "2" Enter; sleep 1 ;;
    *"Do you trust the files"*)                  tmux send-keys -t "=$SESSION:" "1" Enter; sleep 1 ;;
    *"Welcome to Claude Code"*)                  tmux send-keys -t "=$SESSION:" Enter;    sleep 1 ;;
    *"Listening for channel messages"*)
      log "READY: $SESSION listening for channel messages (${i}s)"
      exit 0 ;;
  esac
done

log "WARN: $SESSION did not reach channel-listening within 20s -- may still be booting"
exit 0
