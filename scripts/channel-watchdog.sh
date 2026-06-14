#!/bin/bash
# Independent channels watchdog for the MAIN agent (Genesis / marveen-channels).
#
# WHY a separate process when the dashboard already has an in-process watchdog:
# the dashboard's watchdog dies WITH the dashboard. This one is independent, so a
# wedged channels session is still recovered even if the dashboard process is
# down. It is the COARSE net (total-pipe-death / session-wedge); the dashboard's
# userbot inbound-probe handles the finer inbound-only deafness.
#
# SCHEDULING (card da737e92): this was designed as a systemd --user timer, but
# systemd --user is OFFLINE on this WSL host, so the timer never fires. Instead
# the fleet-supervisor keeps it alive as a reboot-persistent detached loop
# (`--loop`), parented to init like the sub-agent *-watchdog.sh loops, via
# ensure_main_channel_watchdog(). So a dashboard outage no longer leaves the main
# agent with zero recovery. Run modes:
#   channel-watchdog.sh           # single pass (one-shot), then exit
#   channel-watchdog.sh --loop    # daemon: run_once every CHANNEL_WATCHDOG_INTERVAL
#
# DASHBOARD-UP INVARIANT (GATE 0): when the dashboard is up, its in-process
# channel-monitor advances store/.channel-keepalive from ingested inbound and
# respawns the pane on genuine staleness. This watchdog must NOT also act then --
# it judges staleness off the same file and would double-respawn, and worse, if
# the idle keepalive round-trip is briefly absent the file ages while the channel
# is perfectly healthy, looping a respawn on our own pane (the 2026-06-01 churn
# outage). So run_once is a no-op whenever the dashboard answers. This used to be
# enforced by the fleet-supervisor caller; making it intrinsic here keeps the
# invariant correct for every invocation path (loop, manual, hypothetical timer).
#
# Signal: store/.channel-keepalive mtime. The keep-alive scheduled task does a
# real Telegram MCP edit_message round-trip every ~6 min and touches that file
# on success, so a stale file means the session's MCP pipe is no longer doing
# round-trips (wedged / deaf).
#
# Recovery: `tmux respawn-pane` of ONLY the <id>-channels pane. NEVER
# `systemctl restart` -- the tmux SERVER is shared across every agent and lives
# in the channels unit's cgroup (KillMode=control-group), so restarting the unit
# would kill the server and every agent session, not just the main one.
#
# Safety: a respawn-grace stamp prevents storming; a consecutive-respawn cap
# stops a useless respawn loop when the keepalive is disabled or the problem is
# systemic (it then alerts via the log and backs off instead).

set -u

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# STORE is env-overridable (like the supervisor's FLEET_SUPERVISOR_STORE) so a
# test can isolate all watchdog state into a temp dir without touching the live
# store. Live runs leave it unset and use the install store.
STORE="${CHANNEL_WATCHDOG_STORE:-$INSTALL_DIR/store}"
KEEPALIVE_FILE="$STORE/.channel-keepalive"
RESPAWN_STAMP="$STORE/.channel-last-respawn"
RESPAWN_COUNT_FILE="$STORE/.channel-watchdog-respawns"
LOG_TAG="channel-watchdog"

STALE_SECONDS=$(( 15 * 60 ))   # keepalive older than this => wedged/deaf
GRACE_SECONDS=$(( 15 * 60 ))   # don't respawn again within this window
MAX_CONSECUTIVE=3              # after this many respawns w/o recovery, back off + alert

DASH_PORT="${DASH_PORT:-3420}"                       # dashboard health port (env-overridable for tests)
LOOP_INTERVAL="${CHANNEL_WATCHDOG_INTERVAL:-300}"    # --loop cadence; matches the old systemd-timer 5-min cadence
LOOP_ITERS="${CHANNEL_WATCHDOG_LOOP_ITERS:-0}"       # >0 caps loop iterations (test hook); 0 = forever

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$LOG_TAG] $*"; }

# --- resolve the channels session (launch-order / rename independent) ---
MAIN_AGENT_ID="$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
SESSION="${MAIN_AGENT_ID}-channels"

TMUX="$(command -v tmux)"
CLAUDE="$(command -v claude)"
CURL="$(command -v curl)"

# Dashboard liveness. Healthy = HTTP responds on the health port (any status,
# incl. 401 = up+auth-gated). Mirrors the fleet-supervisor's dash_alive so the two
# agree on who owns recovery. curl absent => treat as NOT alive (cannot prove the
# in-process monitor is live), matching the supervisor's prior gate behaviour.
dash_alive() {
  [ -n "$CURL" ] || return 1
  local code
  code=$("$CURL" -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$DASH_PORT/api/health" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ]
}

# One supervision pass. Returns 0 always (a watchdog tick never fails the loop).
run_once() {
  local now ka_mtime age last count
  now=$(date +%s)

  # --- GATE 0: dashboard up => its in-process monitor owns recovery; no-op ---
  if dash_alive; then
    return 0
  fi

  if [ -z "$TMUX" ] || [ -z "$CLAUDE" ]; then
    log "tmux or claude not on PATH; cannot act. PATH=$PATH"
    return 0
  fi

  # --- gate 1: the channels session must EXIST (bridge "running") ---
  if ! "$TMUX" has-session -t "$SESSION" 2>/dev/null; then
    log "session $SESSION not present -- systemd/supervisor owns (re)start; watchdog no-op"
    return 0
  fi

  # --- gate 2: keepalive file must exist (a baseline was established) ---
  # If it never existed, the keep-alive task isn't running -- that's a config
  # matter, not deafness; respawning won't help, so do nothing.
  if [ ! -f "$KEEPALIVE_FILE" ]; then
    log "no keepalive file yet ($KEEPALIVE_FILE) -- keep-alive task not established; no-op"
    return 0
  fi

  # --- gate 3: staleness ---
  ka_mtime=$(stat -c %Y "$KEEPALIVE_FILE" 2>/dev/null || echo 0)
  age=$(( now - ka_mtime ))
  if [ "$age" -lt "$STALE_SECONDS" ]; then
    # Healthy round-trips -> reset the consecutive-respawn counter.
    rm -f "$RESPAWN_COUNT_FILE" 2>/dev/null || true
    return 0
  fi

  # --- gate 4: respawn grace (shared with the dashboard watchdog) ---
  if [ -f "$RESPAWN_STAMP" ]; then
    last=$(stat -c %Y "$RESPAWN_STAMP" 2>/dev/null || echo 0)
    if [ $(( now - last )) -lt "$GRACE_SECONDS" ]; then
      log "keepalive stale ${age}s but within respawn grace -- deferring"
      return 0
    fi
  fi

  # --- gate 5: consecutive-respawn backoff ---
  count=$(cat "$RESPAWN_COUNT_FILE" 2>/dev/null || echo 0)
  case "$count" in (*[!0-9]*|'') count=0;; esac
  if [ "$count" -ge "$MAX_CONSECUTIVE" ]; then
    log "ALERT: keepalive stale ${age}s after $count respawns without recovery -- backing off (keepalive disabled or systemic issue). Manual check needed: tmux attach -t $SESSION"
    return 0
  fi

  # --- recover: respawn-pane ONLY the channels session, fresh claude ---
  local MAIN_MODEL="" MODEL_FLAG="" RESPAWN_CMD
  if [ -f "$INSTALL_DIR/.claude/settings.json" ] && command -v jq >/dev/null 2>&1; then
    MAIN_MODEL="$(jq -r '.model // empty' "$INSTALL_DIR/.claude/settings.json" 2>/dev/null)"
  fi
  [ -n "$MAIN_MODEL" ] && MODEL_FLAG="--model '$MAIN_MODEL' "

  # Full PATH with .bun/bin -- without it the respawned bun telegram bridge does
  # not come up and the session is channel-less.
  RESPAWN_CMD="export PATH=\"/opt/homebrew/bin:\$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin\" && export FLEET_ROOT=\"$INSTALL_DIR\" && . \"$INSTALL_DIR/scripts/lib/fleet-oauth-env.sh\" && $CLAUDE --dangerously-skip-permissions ${MODEL_FLAG}--channels plugin:telegram@claude-plugins-official"

  log "keepalive stale ${age}s (>${STALE_SECONDS}s) and session up -- respawn-pane $SESSION (respawn #$((count+1)))"
  if "$TMUX" respawn-pane -k -t "$SESSION" "$RESPAWN_CMD" 2>/dev/null; then
    date +%s > "$RESPAWN_STAMP"
    echo $(( count + 1 )) > "$RESPAWN_COUNT_FILE"
    log "respawn-pane issued"
  else
    log "respawn-pane FAILED for $SESSION"
  fi
  return 0
}

# Daemon loop: run_once every LOOP_INTERVAL seconds, forever (or LOOP_ITERS times
# for tests). Reboot-persistence is provided by the fleet-supervisor ensure-hook,
# not by this loop.
run_loop() {
  local n=0
  log "channel-watchdog loop started (pid $$, interval ${LOOP_INTERVAL}s)"
  while true; do
    run_once
    n=$(( n + 1 ))
    [ "$LOOP_ITERS" -gt 0 ] && [ "$n" -ge "$LOOP_ITERS" ] && break
    sleep "$LOOP_INTERVAL"
  done
}

# --- main ------------------------------------------------------------------
# Guard so the file can be `source`d by tests (which only want the functions +
# variable definitions above, never an actual run). When executed directly,
# BASH_SOURCE[0] == $0 and a run happens as before.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  case "${1:-}" in
    --loop) run_loop ;;
    "")     run_once ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
fi
