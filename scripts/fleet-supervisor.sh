#!/bin/bash
# fleet-supervisor.sh -- always-on fleet keeper for WSL (no systemd).
#
# WHY THIS EXISTS
# On a normal host, systemd --user timers (Linux) or LaunchAgents (macOS) keep
# the dashboard + channels session alive and tick the watchdogs. This WSL box
# has systemd DISABLED (systemctl is "offline"), so none of that machinery runs:
# nothing restarts a crashed dashboard, nothing relaunches the channels session
# when it fully dies, and nothing schedules channel-watchdog.sh. After a sleep
# or a Windows/WSL reboot the whole fleet stays down until a human intervenes
# (the 2026-06-04 "Genesis elnemulas" incident: Telegram MCP pipe died on a ~9h
# sleep and needed a manual /mcp).
#
# This supervisor is that missing supervision layer. One always-on loop,
# launched at WSL boot via /etc/wsl.conf [boot] (see scripts/fleet-boot.sh).
#
# WHAT IT OWNS  (detect-and-START only -- it NEVER kills a healthy component)
#   1. DASHBOARD  -- tmux session "<main>" running `node dist/index.js`,
#                    listening on 127.0.0.1:3420. Down => relaunch.
#                    The dashboard's own in-process channel-monitor then
#                    supervises the sub-agents (Dave, Buster), so keeping the
#                    dashboard up indirectly keeps the sub-agents up.
#   2. CHANNELS   -- tmux session "<main>-channels" (the main agent / Genesis).
#                    Absent  => relaunch via channels.sh.
#                    Present => tick channel-watchdog.sh, which respawns the
#                    pane if the Telegram MCP pipe is wedged/dead (the thing
#                    that bit us on the sleep). channel-watchdog has its own
#                    staleness/grace/backoff, so calling it every tick is safe.
#   3. DAVE WATCHDOG -- ensure scripts/dave-watchdog.sh is running (it is the
#                    loose loop that revives agent-dave; not systemd-managed).
#
# TOKEN EXHAUSTION
# When the Anthropic budget is spent, a freshly launched claude/dashboard exits
# almost immediately. Each component has a rapid-exit backoff: after a launch we
# require the thing to survive a settle window; consecutive fast failures push
# the next retry out to RETRY_MAX_SECONDS (30 min). The memoria-heartbeat is the
# token-probe -- when budget returns, the next relaunch sticks and the backoff
# resets. No human action needed.
#
# SAFETY
#   * Single instance via flock.
#   * --dry-run logs intended actions without executing (for sandbox tests).
#   * --once runs a single tick and exits (for cron / manual verification).
#   * It only ever STARTS things that are missing; a fully healthy fleet => no-op.
#
# USAGE
#   scripts/fleet-supervisor.sh            # daemon loop (default)
#   scripts/fleet-supervisor.sh --once     # single tick, exit
#   scripts/fleet-supervisor.sh --dry-run  # log-only, no side effects (implies loop unless --once)

set -u

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# STORE is env-overridable (like MAIN_AGENT_ID / DASH_PORT) so a test can isolate
# all supervisor state (STATE_DIR, logs) into a temp dir without touching the live
# store. Live runs leave it unset and use the install store.
STORE="${FLEET_SUPERVISOR_STORE:-$INSTALL_DIR/store}"
LOG="$STORE/fleet-supervisor.log"
LOCK="$STORE/.fleet-supervisor.lock"
STATE_DIR="$STORE/.fleet-supervisor"

TICK_SECONDS=60
SETTLE_SECONDS=8            # how long a freshly launched component must survive
RETRY_BASE_SECONDS=30       # first backoff after a rapid failure
RETRY_MAX_SECONDS=$((30*60))  # cap: token-exhaustion long-wait
# Hibiki token-free daily push: minimum seconds between push invocations from the
# tick loop (the push script is itself idempotent; this only bounds how often we
# spawn python). Matches the old cron cadence. Env-overridable for tests.
HIBIKI_PUSH_THROTTLE_SECONDS="${HIBIKI_PUSH_THROTTLE_SECONDS:-300}"
# Delivery-abandonment sentinel consumer (card d37df625): minimum seconds
# between reader invocations from the tick loop. The CLI is idempotent (a cursor
# file dedupes already-escalated drops); this only bounds how often we spawn
# node. 60s keeps the silent-drop -> operator-ping latency to about a minute.
DELIVERY_SENTINEL_THROTTLE_SECONDS="${DELIVERY_SENTINEL_THROTTLE_SECONDS:-60}"
# Same throttle for the delivery ACK-overdue consumer (card 1a99b7e2). Its CLI
# is idempotent (own cursor + first-run baseline), so this only bounds node spawns.
DELIVERY_ACK_THROTTLE_SECONDS="${DELIVERY_ACK_THROTTLE_SECONDS:-60}"
# Idle-nudge watchdog (card 5899286b): sweep interval + grace period (env-overridable for tests).
# GATED: file absent = fully inert. Activate only after Thor's fixture harness (845750ad) proves
# the pane-state detector does not false-positive on thinking/done agents.
IDLE_NUDGE_THROTTLE_SECONDS="${IDLE_NUDGE_THROTTLE_SECONDS:-300}"   # 5 min between sweeps
IDLE_NUDGE_GRACE_SECONDS="${IDLE_NUDGE_GRACE_SECONDS:-300}"          # idle for 5 min before nudge
IDLE_NUDGE_LOOKBACK_SECONDS="${IDLE_NUDGE_LOOKBACK_SECONDS:-21600}"  # 6 h obligation window
# STATIC nudge text -- content MUST be a hard-coded constant; never derived from DB/user
# data (Chad security requirement: send-keys is an injection surface; a static string
# eliminates dynamic content as an attack vector).
IDLE_NUDGE_TEXT="Please continue your current task."
# CLI version watch (card b1739f30): how often to compare `claude --version` against the
# stored baseline. 1-hour default keeps alert latency short without flooding the API.
CLI_VERSION_CHECK_THROTTLE_SECONDS="${CLI_VERSION_CHECK_THROTTLE_SECONDS:-3600}"

DRY_RUN=0
ONCE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --once)    ONCE=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$STORE" "$STATE_DIR"

# Full PATH so bun/node/claude/tmux resolve identically to channels.sh, whether
# we were launched from a login shell or the bare /etc/wsl.conf [boot] context.
export PATH="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"

# Scrub tmux's own socket env var. If the supervisor is launched from inside a
# tmux pane (e.g. a manual run, or relaunched by channels.sh), an inherited
# $TMUX makes `tmux new-session` try to nest and makes our tmux calls bind to
# the wrong server. Unsetting it forces a clean client to the default socket --
# the same reason channels.sh does it. (Also: never name a var TMUX -- it would
# re-pollute this very env var and break has-session.)
unset TMUX

TMUX_BIN="$(command -v tmux || true)"
NODE="$(command -v node || true)"
CURL="$(command -v curl || true)"

# Write to stderr only. The daemon (fleet-boot.sh) and cron invocations redirect
# stderr into $LOG, so a single channel avoids the tee+redirect double-logging.
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [fleet-supervisor] $*" >&2; }

# --- resolve main agent id (rename-independent) ---
# Explicit MAIN_AGENT_ID env wins (lets a dry-run target a sandbox id without
# touching the live fleet); otherwise read the install .env; else fall back.
MAIN_AGENT_ID="${MAIN_AGENT_ID:-$(grep -E '^MAIN_AGENT_ID=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2-)}"
MAIN_AGENT_ID="${MAIN_AGENT_ID:-marveen}"
MAIN_AGENT_ID="${MAIN_AGENT_ID//[^a-zA-Z0-9_-]/}"
DASH_SESSION="$MAIN_AGENT_ID"
CHAN_SESSION="${MAIN_AGENT_ID}-channels"
DASH_PORT="${DASH_PORT:-3420}"   # env-overridable (e.g. point at a closed port to sim dashboard-down)

# --- per-component backoff -------------------------------------------------
# State files: <STATE_DIR>/<comp>.fails (consecutive rapid failures),
#              <STATE_DIR>/<comp>.next  (epoch before which we won't retry).
backoff_blocked() {            # comp -> 0 if we may act, 1 if still backing off
  local comp="$1" nextf="$STATE_DIR/$1.next" now next
  now=$(date +%s)
  [ -f "$nextf" ] || return 0
  next=$(cat "$nextf" 2>/dev/null || echo 0); case "$next" in (*[!0-9]*|'') next=0;; esac
  [ "$now" -ge "$next" ] && return 0 || return 1
}
backoff_note_launch() {        # comp -- remember when we launched, for settle check
  date +%s > "$STATE_DIR/$1.launched"
}
backoff_register_failure() {   # comp -- escalate next-retry delay
  local comp="$1" failf="$STATE_DIR/$1.fails" fails delay
  fails=$(cat "$failf" 2>/dev/null || echo 0); case "$fails" in (*[!0-9]*|'') fails=0;; esac
  fails=$((fails+1)); echo "$fails" > "$failf"
  delay=$(( RETRY_BASE_SECONDS * (1 << (fails-1)) ))
  [ "$delay" -gt "$RETRY_MAX_SECONDS" ] && delay=$RETRY_MAX_SECONDS
  echo $(( $(date +%s) + delay )) > "$STATE_DIR/$comp.next"
  log "$comp: launch failed/rapid-exit (#$fails) -- next retry in ${delay}s"
}
backoff_reset() {              # comp -- healthy: clear failure state
  rm -f "$STATE_DIR/$1.fails" "$STATE_DIR/$1.next" 2>/dev/null || true
}
# After a launch, if the thing died inside the settle window, treat as failure.
settle_check() {               # comp predicate_cmd... -> registers failure if dead
  local comp="$1"; shift
  local launchedf="$STATE_DIR/$comp.launched" launched now
  [ -f "$launchedf" ] || return 0
  launched=$(cat "$launchedf" 2>/dev/null || echo 0); case "$launched" in (*[!0-9]*|'') launched=0;; esac
  now=$(date +%s)
  # Only judge within one tick after a launch.
  [ $(( now - launched )) -gt $(( SETTLE_SECONDS + 5 )) ] && { rm -f "$launchedf"; return 0; }
  [ $(( now - launched )) -lt "$SETTLE_SECONDS" ] && return 0   # too soon, judge next tick
  rm -f "$launchedf"
  if "$@"; then backoff_reset "$comp"; else backoff_register_failure "$comp"; fi
}

run() {                        # execute unless dry-run
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: $*"; return 0; fi
  "$@"
}

# --- liveness predicates ---------------------------------------------------
dash_alive() {
  # Healthy = HTTP responds on :3420 (any status, incl. 401 = up+auth-gated).
  [ -n "$CURL" ] || return 1
  local code
  code=$("$CURL" -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$DASH_PORT/api/health" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ]
}
session_alive() { [ -n "$TMUX_BIN" ] && "$TMUX_BIN" has-session -t "$1" 2>/dev/null; }

# --- launchers -------------------------------------------------------------
launch_dashboard() {
  # node dist/index.js inside tmux session "<main>", cwd = install dir.
  # The app loads its own .env; the tmux server global env (claude token) is
  # populated by channels.sh, so sub-agent launches work once channels is up.
  if [ ! -f "$INSTALL_DIR/dist/index.js" ]; then
    log "dashboard: dist/index.js missing -- run 'npm run build' first; skipping launch"
    return 1
  fi
  "$TMUX_BIN" kill-session -t "$DASH_SESSION" 2>/dev/null || true
  # 9>&- closes the single-instance flock fd so it never leaks into the tmux
  # server (and thus the long-lived node dashboard). Without it, a tmux server
  # first started by this launch inherits fd 9 and every pane keeps the lock
  # held, so a later supervisor restart fails "lock held" until the lock inode
  # is rm'd. Every other launch site in this file already does this; this was
  # the one gap (card 09fa76f2).
  run "$TMUX_BIN" new-session -d -s "$DASH_SESSION" -c "$INSTALL_DIR" \
      "export PATH=\"$PATH\" && exec $NODE dist/index.js" 9>&-
  backoff_note_launch dashboard
  log "dashboard: launched (tmux $DASH_SESSION -> node dist/index.js)"
}
launch_channels() {
  # channels.sh self-manages the session, blocks while it lives, and has its
  # own rapid-exit backoff. Background + disown so the supervisor loop continues.
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: bash scripts/channels.sh (background)"; return 0; fi
  nohup bash "$INSTALL_DIR/scripts/channels.sh" >> "$STORE/channels.log" 2>&1 9>&- &
  disown 2>/dev/null || true
  backoff_note_launch channels
  log "channels: launched scripts/channels.sh (session $CHAN_SESSION)"
}
ensure_dave_watchdog() {
  pgrep -f "scripts/dave-watchdog.sh" >/dev/null 2>&1 && return 0
  if [ -x "$INSTALL_DIR/scripts/dave-watchdog.sh" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: start dave-watchdog.sh"; return 0; fi
    nohup bash "$INSTALL_DIR/scripts/dave-watchdog.sh" >> "$STORE/dave-watchdog.log" 2>&1 9>&- &
    disown 2>/dev/null || true
    log "dave-watchdog: started"
  fi
}
# Channel-less role agents (Gauge/Quill/Scout/Applegate): each is kept alive by the
# generic scripts/agent-watchdog.sh <name> loop. Ensure one watchdog per agent,
# mirroring ensure_dave_watchdog. These are permanent fleet members (2026-06-05),
# so they must come back after a WSL reboot like Dave does.
# NOTE: forge(Armorer) and chad moved to ensure_channel_watchdogs (2026-06-05) --
# they were given per-agent Telegram bots, so they need the channel-aware watchdog
# (fresh launch + --channels + TELEGRAM_STATE_DIR), not the channel-less one.
ensure_agent_watchdogs() {
  for n in gauge quill scout applegate radar; do
    pgrep -f "scripts/agent-watchdog.sh $n\$" >/dev/null 2>&1 && continue
    if [ -x "$INSTALL_DIR/scripts/agent-watchdog.sh" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: start agent-watchdog.sh $n"; continue; fi
      nohup bash "$INSTALL_DIR/scripts/agent-watchdog.sh" "$n" >> "$STORE/${n}-watchdog.log" 2>&1 9>&- &
      disown 2>/dev/null || true
      log "agent-watchdog $n: started"
    fi
  done
}

# Channel agents (per-agent Telegram bot): each has its own dedicated channel-aware
# watchdog scripts/<name>-watchdog.sh (fresh launch + --channels + TELEGRAM_STATE_DIR,
# NOT the channel-less generic one). Ensures reboot-persistence + recovery. thor is
# included so its standalone watchdog also becomes reboot-persistent (pgrep-skip keeps
# an already-running one). 2026-06-05.
ensure_channel_watchdogs() {
  for n in forge chad thor claudia bigben hibiki devil-advocate bond; do
    pgrep -f "scripts/${n}-watchdog.sh" >/dev/null 2>&1 && continue
    if [ -x "$INSTALL_DIR/scripts/${n}-watchdog.sh" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: start ${n}-watchdog.sh"; continue; fi
      nohup bash "$INSTALL_DIR/scripts/${n}-watchdog.sh" >> "$STORE/${n}-watchdog.log" 2>&1 9>&- &
      disown 2>/dev/null || true
      log "${n}-watchdog: started"
    fi
  done
}

# Telegram MCP-pipe watchdog for the MAIN orchestrator (scripts/telegram-pipe-watchdog.sh,
# PR#27). A self-looping daemon (5-min cycles) that is INDEPENDENT of both the orchestrator
# session and the dashboard, so it survives a dashboard restart and can drive /mcp recovery
# itself when the Telegram MCP bun child dies on a long sleep. It was launched by hand once,
# so a WSL reboot left it dead until a human restarted it. Wiring it here makes it
# reboot-persistent like every other watchdog: pgrep-skip keeps a running one, otherwise
# relaunch. The pattern matches only the .sh daemon, not the node "-cli.js" cycle invocation,
# so there is exactly one match -- no double-launch (two loops racing /mcp recovery). 2026-06-07.
ensure_pipe_watchdog() {
  pgrep -f "scripts/telegram-pipe-watchdog.sh" >/dev/null 2>&1 && return 0
  if [ -x "$INSTALL_DIR/scripts/telegram-pipe-watchdog.sh" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: start telegram-pipe-watchdog.sh"; return 0; fi
    nohup bash "$INSTALL_DIR/scripts/telegram-pipe-watchdog.sh" >> "$STORE/telegram-pipe-watchdog.log" 2>&1 9>&- &
    disown 2>/dev/null || true
    log "telegram-pipe-watchdog: started"
  fi
}

# Token-outage auto-ACK watcher (scripts/token-outage-watch.sh, P3). A self-looping
# deterministic daemon (~30s cycles) INDEPENDENT of the dashboard, so it keeps the
# operator informed + captures/re-dispatches the queue even while the Claude account
# is usage-limited (when the orchestrator session is frozen and the dashboard may be
# the only thing still answering). Reboot-persistent like the pipe watchdog: pgrep-skip
# keeps a running one, otherwise relaunch. Pattern matches only the .sh daemon, not the
# node "-cli.js" cycle invocation.
ensure_token_outage_watch() {
  pgrep -f "scripts/token-outage-watch.sh" >/dev/null 2>&1 && return 0
  if [ -x "$INSTALL_DIR/scripts/token-outage-watch.sh" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: start token-outage-watch.sh"; return 0; fi
    nohup bash "$INSTALL_DIR/scripts/token-outage-watch.sh" >> "$STORE/token-outage-watch.log" 2>&1 9>&- &
    disown 2>/dev/null || true
    log "token-outage-watch: started"
  fi
}

# Medic break-glass operator bot watchdog (scripts/medic-watchdog.sh, card fc252db2).
# Medic is the token-free, model-free Telegram recovery bot (pure-Python stdlib, like
# hibiki-daily-push) -- it must be ALWAYS-ON so the Boss can command the fleet back up
# even when the OAuth token is dead. Reboot-persistent like the pipe watchdog: pgrep-skip
# keeps a running watchdog, otherwise relaunch. The pattern matches only the .sh daemon,
# not the python "scripts/medic/bot.py" process (which the watchdog itself owns), so there
# is exactly one match -- no double-launch. 9>&- so it never inherits the supervisor flock
# fd. 2026-06-10.
ensure_medic_watchdog() {
  pgrep -f "scripts/medic-watchdog.sh" >/dev/null 2>&1 && return 0
  if [ -x "$INSTALL_DIR/scripts/medic-watchdog.sh" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: start medic-watchdog.sh"; return 0; fi
    nohup bash "$INSTALL_DIR/scripts/medic-watchdog.sh" >> "$STORE/medic-watchdog.log" 2>&1 9>&- &
    disown 2>/dev/null || true
    log "medic-watchdog: started"
  fi
}

# Local-Ollama hybrid agents (marveen-local / claudia-local, card ollama-hybrid).
# Gated behind a deploy flag so merging the wiring is INERT: the local agents and
# their Ollama daemon are only brought up once an operator (Genesis) has validated
# the build on c12 and touched store/ollama-hybrid.enabled. Without the flag this
# is a pure no-op, so a stock box never starts Ollama or a local agent.
#
# ensure_ollama: best-effort start of the Ollama daemon when the flag is set and
# the daemon is down. The local-agent watchdogs do their own pre-launch health
# check and refuse to launch a session until an allowlisted model is served, so a
# slow/failed Ollama start can never produce a token-burning cloud-model launch.
ollama_hybrid_enabled() { [ -f "$INSTALL_DIR/store/ollama-hybrid.enabled" ]; }
ensure_ollama() {
  ollama_hybrid_enabled || return 0
  curl -sf --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1 && return 0
  command -v ollama >/dev/null 2>&1 || { log "ensure_ollama: ollama binary not found -- skipping"; return 0; }
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: start ollama serve"; return 0; fi
  nohup ollama serve >> "$STORE/ollama-serve.log" 2>&1 9>&- &
  disown 2>/dev/null || true
  log "ensure_ollama: started ollama serve"
}
# Each local agent is kept alive by scripts/local-agent-watchdog.sh <name> (FATAL
# dual-check, pre-launch Ollama health check, Ollama launch env, adaptive
# context-saturation restart). Reboot-persistent via pgrep-skip like every other
# watchdog. Gated by the same deploy flag.
ensure_local_agent_watchdogs() {
  ollama_hybrid_enabled || return 0
  for n in marveen-local claudia-local; do
    [ -f "$INSTALL_DIR/agents/$n/agent-config.json" ] || continue
    pgrep -f "scripts/local-agent-watchdog.sh $n\$" >/dev/null 2>&1 && continue
    if [ -x "$INSTALL_DIR/scripts/local-agent-watchdog.sh" ]; then
      if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: start local-agent-watchdog.sh $n"; continue; fi
      nohup bash "$INSTALL_DIR/scripts/local-agent-watchdog.sh" "$n" >> "$STORE/${n}-watchdog.log" 2>&1 9>&- &
      disown 2>/dev/null || true
      log "local-agent-watchdog $n: started"
    fi
  done
}

# Tailnet-only dashboard reboot-persistence (card c2de413f). WSL has no systemd, so
# neither tailscaled nor the `tailscale serve` config survives a reboot; the always-on
# supervisor brings both back. Gated by store/tailscale-serve.enabled (inert until
# Genesis-GO), and the hook NEVER performs an interactive login -- the one-time
# `tailscale up` is the operator's. All logic + tests live in ensure-tailscaled.sh.
tailscale_serve_enabled() { [ -f "$STORE/tailscale-serve.enabled" ]; }
ensure_tailscaled() {
  tailscale_serve_enabled || return 0
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: run ensure-tailscaled.sh"; return 0; fi
  [ -x "$INSTALL_DIR/scripts/ensure-tailscaled.sh" ] || return 0
  bash "$INSTALL_DIR/scripts/ensure-tailscaled.sh" >> "$STORE/tailscaled.log" 2>&1 || true
}

# Hibiki token-free daily push (spec B-AC2). WSL has no systemd, so a real cron
# daemon needs `sudo service cron start` after every boot -- too fragile for a
# token-free guarantee. The supervisor is already always-on (started reboot-safe
# from fleet-boot.sh), so we tick the push here instead. The push script is fully
# idempotent (a per-day state file dedupes every action), so calling it can never
# double-send; the throttle below only bounds how often we spawn python. 2026-06-08.
hibiki_push_due() {            # -> 0 if the throttle window has elapsed, 1 if not
  local nextf="$STATE_DIR/hibiki-push.next" now next
  now=$(date +%s)
  [ -f "$nextf" ] || return 0
  next=$(cat "$nextf" 2>/dev/null || echo 0); case "$next" in (*[!0-9]*|'') next=0;; esac
  [ "$now" -ge "$next" ]
}
ensure_hibiki_push() {
  local push="$INSTALL_DIR/scripts/hibiki-daily-push.py"
  [ -f "$push" ] || return 0          # pipeline not installed -> nothing to do
  hibiki_push_due || return 0         # throttled this tick
  echo $(( $(date +%s) + HIBIKI_PUSH_THROTTLE_SECONDS )) > "$STATE_DIR/hibiki-push.next"
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: hibiki-daily-push.py --quiet"; return 0; fi
  python3 "$push" --quiet >> "$STORE/hibiki-push.log" 2>&1 \
    || log "hibiki-push: tick invocation failed (non-fatal, retries next window)"
}

# Delivery-abandonment sentinel consumer (card d37df625). PR #130 writes a
# durable JSONL trail of every abandoned inter-agent message; this reads NEW
# lines each tick and escalates them OUT OF BAND (Telegram Bot API fallback),
# so a drop whose in-band alert was also lost no longer means a silent
# multi-hour gap. Gated behind store/delivery-sentinel-watch.enabled so MERGING
# the wiring is INERT -- the consumer only runs once an operator (Genesis/Forge)
# has validated the build on c12 and touched the flag, mirroring the
# ollama/tailscale deploy-flag pattern. The CLI itself is idempotent (a cursor
# file dedupes already-escalated drops + baselines history on first run), so the
# throttle below only bounds how often we spawn node.
delivery_sentinel_watch_enabled() { [ -f "$STORE/delivery-sentinel-watch.enabled" ]; }
delivery_sentinel_due() {        # -> 0 if the throttle window has elapsed, 1 if not
  local nextf="$STATE_DIR/delivery-sentinel.next" now next
  now=$(date +%s)
  [ -f "$nextf" ] || return 0
  next=$(cat "$nextf" 2>/dev/null || echo 0); case "$next" in (*[!0-9]*|'') next=0;; esac
  [ "$now" -ge "$next" ]
}
ensure_delivery_sentinel_watch() {
  delivery_sentinel_watch_enabled || return 0   # inert until operator-enabled
  local cli="$INSTALL_DIR/dist/delivery-sentinel-cli.js"
  [ -f "$cli" ] || { log "delivery-sentinel: dist/delivery-sentinel-cli.js missing -- run build; skipping"; return 0; }
  delivery_sentinel_due || return 0             # throttled this tick
  echo $(( $(date +%s) + DELIVERY_SENTINEL_THROTTLE_SECONDS )) > "$STATE_DIR/delivery-sentinel.next"
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: node dist/delivery-sentinel-cli.js"; return 0; fi
  run env -u TMUX MARVEEN_ROOT="$INSTALL_DIR" "$NODE" "$cli" >> "$STORE/delivery-sentinel.log" 2>&1 \
    || log "delivery-sentinel: tick invocation failed (non-fatal, retries next window)"
}

# Delivery ACK-overdue consumer (card 1a99b7e2). PR #133 writes a pending-ack
# trail on inject of an ack_expected message; the in-process observer clears one
# once the recipient engages. This reads what stays OUTSTANDING (pending minus
# cleared) and escalates the ones overdue past the 15-min window OUT OF BAND
# (Telegram Bot API fallback), so an ack_expected delegation that never reached
# a turn no longer fails silently. Gated behind store/delivery-ack-watch.enabled
# so MERGING the wiring is INERT until an operator (Genesis/Forge) validates the
# build on c12 and touches the flag -- same pattern as the abandonment consumer.
delivery_ack_watch_enabled() { [ -f "$STORE/delivery-ack-watch.enabled" ]; }
delivery_ack_due() {             # -> 0 if the throttle window has elapsed, 1 if not
  local nextf="$STATE_DIR/delivery-ack.next" now next
  now=$(date +%s)
  [ -f "$nextf" ] || return 0
  next=$(cat "$nextf" 2>/dev/null || echo 0); case "$next" in (*[!0-9]*|'') next=0;; esac
  [ "$now" -ge "$next" ]
}
ensure_delivery_ack_watch() {
  delivery_ack_watch_enabled || return 0        # inert until operator-enabled
  local cli="$INSTALL_DIR/dist/delivery-ack-cli.js"
  [ -f "$cli" ] || { log "delivery-ack: dist/delivery-ack-cli.js missing -- run build; skipping"; return 0; }
  delivery_ack_due || return 0                  # throttled this tick
  echo $(( $(date +%s) + DELIVERY_ACK_THROTTLE_SECONDS )) > "$STATE_DIR/delivery-ack.next"
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: node dist/delivery-ack-cli.js"; return 0; fi
  run env -u TMUX MARVEEN_ROOT="$INSTALL_DIR" "$NODE" "$cli" >> "$STORE/delivery-ack.log" 2>&1 \
    || log "delivery-ack: tick invocation failed (non-fatal, retries next window)"
}

# --- IDLE-NUDGE WATCHDOG (card 5899286b) -----------------------------------
# Obligation-driven idle detector: if a running agent has an open delegated
# task in agent_messages AND its tmux pane has been idle at the empty prompt
# for IDLE_NUDGE_GRACE_SECONDS, send a static resume nudge via send-keys.
#
# The two-predicate gate (pane idle + open obligation) ensures:
#   * A legitimately done agent (no open obligation) is never nudged.
#   * An agent mid-thinking/working (pane shows spinner/esc bar) is never
#     nudged even if an old obligation row exists from a prior turn.
#
# GATED: store/idle-nudge-watch.enabled must exist. MERGE IS INERT.
# Activate only after Thor's negative-fixture harness (845750ad) has proven
# the pane predicate does not false-positive on thinking/done panes.
idle_nudge_watch_enabled() { [ -f "$STORE/idle-nudge-watch.enabled" ]; }
idle_nudge_due() {
  local nextf="$STATE_DIR/idle-nudge.next" now next
  now=$(date +%s)
  [ -f "$nextf" ] || return 0
  next=$(cat "$nextf" 2>/dev/null || echo 0); case "$next" in (*[!0-9]*|'') next=0;; esac
  [ "$now" -ge "$next" ]
}

# Returns 0 (true) when the pane looks idle at the empty shell prompt.
# Returns 1 when the pane shows any working indicator.
# Accepts the tmux session name as $1.
pane_is_idle_at_prompt() {
  local session="$1" pane_tail
  pane_tail=$("$TMUX_BIN" capture-pane -t "$session" -p 2>/dev/null | tail -6)
  # Working indicators: "esc to interrupt" bar, Thinking text, braille spinner
  echo "$pane_tail" | grep -qE "esc to interrupt|Thinking|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]" && return 1
  # Idle indicator: clean ❯ prompt present in the last few lines
  echo "$pane_tail" | grep -qE "^❯[[:space:]]*$" && return 0
  return 1
}

# Returns 0 (true) when agent has at least one open obligation: a delivered/
# pending agent_messages row to this agent with no completed_at, within the
# IDLE_NUDGE_LOOKBACK_SECONDS window.
agent_has_open_obligation() {
  local agent="$1" db count
  db="$STORE/claudeclaw.db"
  [ -f "$db" ] || return 1
  count=$(python3 -c "
import sqlite3, sys, time
try:
    db = sqlite3.connect('$db')
    since = int(time.time()) - $IDLE_NUDGE_LOOKBACK_SECONDS
    row = db.execute(\"\"\"SELECT COUNT(*) FROM agent_messages
        WHERE to_agent=? AND status IN ('delivered','pending')
        AND completed_at IS NULL AND created_at > ?\"\"\", ('$agent', since)).fetchone()
    print(row[0] if row else 0)
    db.close()
except Exception:
    print(0)
" 2>/dev/null)
  [ -n "$count" ] && [ "$count" -gt 0 ]
}

ensure_idle_nudge_watch() {
  idle_nudge_watch_enabled || return 0   # inert until operator-enabled (+ Thor 845750ad harness green)
  idle_nudge_due || return 0
  echo $(( $(date +%s) + IDLE_NUDGE_THROTTLE_SECONDS )) > "$STATE_DIR/idle-nudge.next"
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: idle-nudge sweep all running agents"; return 0; fi

  local now agent idle_since_f idle_since idle_age
  now=$(date +%s)

  # Enumerate running agents via the dashboard API
  local running_agents
  running_agents=$(curl -sf --max-time 3 \
    -H "Authorization: Bearer $(cat "$STORE/.dashboard-token" 2>/dev/null)" \
    "http://127.0.0.1:$DASH_PORT/api/agents" 2>/dev/null \
    | python3 -c "import sys,json; [print(a['name']) for a in json.load(sys.stdin) if a.get('running')]" 2>/dev/null \
    || true)

  for agent in $running_agents; do
    # Sanitize: agent names must be alphanumeric/dash/underscore only
    # (defence-in-depth: blocks code injection into python3 -c and path traversal in idle-since-$agent)
    [[ "$agent" =~ ^[a-zA-Z0-9_-]+$ ]] || { log "skip agent: invalid name '$agent'"; continue; }
    local session="agent-$agent"
    # Skip non-existent sessions
    session_alive "$session" || { rm -f "$STATE_DIR/idle-since-$agent"; continue; }

    # Reset idle timer if pane is actively working
    if ! pane_is_idle_at_prompt "$session"; then
      rm -f "$STATE_DIR/idle-since-$agent"
      continue
    fi

    # Idle pane: only nudge if there is an open obligation
    if ! agent_has_open_obligation "$agent"; then
      rm -f "$STATE_DIR/idle-since-$agent"
      continue
    fi

    # Track how long this agent has been idle with an open obligation
    idle_since_f="$STATE_DIR/idle-since-$agent"
    if [ ! -f "$idle_since_f" ]; then
      echo "$now" > "$idle_since_f"
      continue  # Grace period starts now
    fi
    idle_since=$(cat "$idle_since_f" 2>/dev/null || echo "$now")
    case "$idle_since" in (*[!0-9]*|'') idle_since="$now";; esac
    idle_age=$(( now - idle_since ))
    if [ "$idle_age" -lt "$IDLE_NUDGE_GRACE_SECONDS" ]; then
      continue  # Still within grace period -- do not nudge yet
    fi

    # Grace period elapsed with an open obligation and idle pane: nudge
    log "idle-nudge: $agent idle ${idle_age}s with open obligation -- sending resume nudge"
    "$TMUX_BIN" send-keys -t "$session" -l "$IDLE_NUDGE_TEXT"
    sleep 0.4
    "$TMUX_BIN" send-keys -t "$session" Enter
    rm -f "$idle_since_f"
  done
}

# --- CLI VERSION WATCH (card b1739f30) ------------------------------------
# pane-state.ts detectors are tied to specific footer/input-box patterns from a
# known CLI version (PANE_DETECTOR_BASELINE_CLI_VERSION). A Claude Code upgrade
# that changes those patterns can silently break idle/busy detection -- neither
# the test suite nor the sentinel catches this because they run against pre-captured
# fixtures, not live pane output. This function detects the upgrade automatically
# and fires a dead-pipe-proof HTTPS alert so an operator can run c12 smoke before
# activating any pane-dependent watchdog (idle-nudge, stuck-input, etc.).
cli_version_check_due() {
  local nextf="$STATE_DIR/cli-version-check.next" now next
  now=$(date +%s)
  [ -f "$nextf" ] || return 0
  next=$(cat "$nextf" 2>/dev/null || echo 0); case "$next" in (*[!0-9]*|'') next=0;; esac
  [ "$now" -ge "$next" ]
}
ensure_cli_version_watch() {
  cli_version_check_due || return 0
  echo $(( $(date +%s) + CLI_VERSION_CHECK_THROTTLE_SECONDS )) > "$STATE_DIR/cli-version-check.next"
  local claude_bin
  # CLAUDE_BIN_OVERRIDE: env-overridable for tests (same pattern as FLEET_SUPERVISOR_STORE).
  # Single-dash ${VAR-default}: default fires only when UNSET; empty string passes through
  # so tests can force the not-found path with CLAUDE_BIN_OVERRIDE="".
  claude_bin="${CLAUDE_BIN_OVERRIDE-$(command -v claude 2>/dev/null)}"
  [ -n "$claude_bin" ] || return 0
  [ -x "$claude_bin" ] || return 0
  local current_ver
  current_ver=$("$claude_bin" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) || return 0
  [ -n "$current_ver" ] || return 0
  local ver_file="$STATE_DIR/claude-cli-version.txt"
  if [ ! -f "$ver_file" ]; then
    echo "$current_ver" > "$ver_file"
    log "cli-version-watch: baseline recorded ($current_ver)"
    return 0
  fi
  local stored_ver
  stored_ver=$(cat "$ver_file" 2>/dev/null); case "$stored_ver" in (*[!0-9.]*|'') stored_ver="";; esac
  [ "$current_ver" != "$stored_ver" ] || return 0
  echo "$current_ver" > "$ver_file"
  log "cli-version-watch: CLI changed ${stored_ver:-unknown} -> $current_ver -- mandatory c12 pane-detector smoke required"
  if [ "$DRY_RUN" -eq 1 ]; then log "DRY-RUN would: send Telegram HTTPS alert for CLI version change"; return 0; fi
  local env_file="$INSTALL_DIR/agents/chad/.claude/channels/telegram/.env" token
  token=$(grep 'TELEGRAM_BOT_TOKEN=' "$env_file" 2>/dev/null | cut -d= -f2- | tr -d '[:space:]') || true
  if [ -n "$token" ] && [ -n "$CURL" ]; then
    "$CURL" -sf --max-time 10 \
      "https://api.telegram.org/bot${token}/sendMessage" \
      -d "chat_id=8643929442" \
      --data-urlencode "text=[Chad] Claude Code CLI frissult: ${stored_ver:-ismeretlen} -> ${current_ver}. Kotelezo c12 pane-detektor smoke mielott barmely pane-fuggo watchdog (idle-nudge, stuck-input) aktivalodna. Ha smoke PASS: src/pane-state.ts PANE_DETECTOR_BASELINE_CLI_VERSION = '${current_ver}' frissitendo." \
      >/dev/null 2>&1 \
      && log "cli-version-watch: HTTPS alert sent" \
      || log "cli-version-watch: HTTPS alert failed (non-fatal)"
  else
    log "cli-version-watch: no chad telegram token -- alert suppressed"
  fi
}

# --- one supervision pass --------------------------------------------------
# Credential locations, env-overridable so the reconcile unit test can isolate
# them into a temp dir (same pattern as FLEET_SUPERVISOR_STORE) without touching
# the live tokens.
MAIN_CRED="${FLEET_MAIN_CRED:-$HOME/.claude/.credentials.json}"
AGENTS_DIR="${FLEET_AGENTS_DIR:-$INSTALL_DIR/agents}"

# Echo the numeric claudeAiOauth.expiresAt from a credentials file, or nothing
# on any error (missing / corrupt / not-a-cred-file). Used to compare token
# freshness between a drifted standalone file and the main token.
cred_expires_at() {
  python3 - "$1" 2>/dev/null <<'PY'
import sys, json
try:
    with open(sys.argv[1]) as fh:
        d = json.load(fh)
    print(int(d["claudeAiOauth"]["expiresAt"]))
except Exception:
    pass
PY
}

# Keep every sub-agent's OAuth credentials a symlink to the single main token
# ($HOME/.claude/.credentials.json), which auto-refreshes. A sub-agent's Claude
# can refresh via atomic-rename, which silently replaces the symlink with a
# standalone file -- it then drifts to its own expiry and prompts for re-auth
# (the dave/thor outage on 2026-06-05). Reconcile every tick so it self-heals.
#
# PROMOTE-ON-DRIFT (2026-06-08): only ever re-linking a drifted agent back to
# main DISCARDS the fresh token that agent's Claude just minted -- so the fleet
# kept riding the EXPIRED main token until something else happened to refresh it
# (the 2026-06-08 outage: hibiki refreshed at 11:55, main not updated until 12:57,
# and in between Genesis+Claudia hit re-auth prompts and froze). Fix: when a
# drifted standalone token is NEWER than main, PROMOTE it up to main first, so a
# refresh by ANY agent heals the single shared token for everyone.
reconcile_agent_creds() {
  local main="$MAIN_CRED"
  [ -e "$main" ] || return 0
  local f
  for f in "$AGENTS_DIR"/*/.claude-config/.credentials.json; do
    [ -e "$f" ] || continue
    # Already the correct symlink? leave it.
    if [ -L "$f" ] && [ "$(readlink "$f")" = "$main" ]; then
      continue
    fi
    # Drifted into a standalone file (a sub-agent refreshed in place). Back it up,
    # promote it to main if it is newer, then re-link. A wrong-target symlink (the
    # else case below) just gets re-linked -- a symlink carries no fresh token.
    if [ ! -L "$f" ]; then
      cp -a "$f" "$f.drift-$(date +%Y%m%d-%H%M%S)" 2>/dev/null
      local agent fexp mexp
      agent="$(basename "$(dirname "$(dirname "$f")")")"
      fexp="$(cred_expires_at "$f")"
      mexp="$(cred_expires_at "$main")"
      # Promote when the drifted token parses AND (main is unparseable OR older).
      if [ -n "$fexp" ] && { [ -z "$mexp" ] || [ "$fexp" -gt "$mexp" ]; }; then
        local tmp="$main.promote.$$"
        if cp "$f" "$tmp" 2>/dev/null && chmod 600 "$tmp" 2>/dev/null && mv -f "$tmp" "$main" 2>/dev/null; then
          log "creds: $agent refreshed the token (exp $fexp > main ${mexp:-none}) -- promoted to main, re-linking"
        else
          rm -f "$tmp" 2>/dev/null
          log "creds: $agent drifted (newer) but promote to main FAILED -- re-linking to main"
        fi
      else
        log "creds: $agent drifted to standalone file (not newer) -- re-linking to main token"
      fi
    fi
    ln -sf "$main" "$f"
  done
}

tick() {
  [ -n "$TMUX_BIN" ] || { log "tmux not on PATH -- cannot supervise"; return; }

  # 0) CREDENTIALS -- keep all agents on the single auto-refreshing main token
  reconcile_agent_creds

  # 1) DASHBOARD
  settle_check dashboard dash_alive
  if dash_alive; then
    backoff_reset dashboard
  elif backoff_blocked dashboard; then
    if session_alive "$DASH_SESSION"; then
      log "dashboard: session up but :$DASH_PORT not responding -- relaunching"
      launch_dashboard
    else
      log "dashboard: down -- launching"
      launch_dashboard
    fi
  fi

  # 2) CHANNELS
  if session_alive "$CHAN_SESSION"; then
    backoff_reset channels
    # Pipe-death recovery (Telegram MCP wedged but session up) is OWNED by the
    # dashboard's IN-PROCESS channel-monitor whenever the dashboard is up: it
    # advances store/.channel-keepalive from ingested inbound messages and
    # respawns the pane on genuine staleness. We must NOT also run the external
    # channel-watchdog then -- it judges staleness off the same file and would
    # double-respawn, and worse, if the idle keepalive round-trip is absent the
    # file ages while the channel is perfectly healthy, looping a respawn on our
    # own pane (the 2026-06-01 churn outage). So fall back to the external coarse
    # watchdog ONLY when the dashboard (and thus its monitor) is DOWN.
    if ! dash_alive && [ -x "$INSTALL_DIR/scripts/channel-watchdog.sh" ]; then
      log "channels: dashboard down -- running external channel-watchdog as backup"
      run env -u TMUX bash "$INSTALL_DIR/scripts/channel-watchdog.sh"
    fi
  else
    # A fully-absent channels session is recreated by nobody else (the dashboard
    # monitor respawns an existing pane; it does not recreate a killed session,
    # and there is no systemd unit here to do it). That is our job.
    settle_check channels "session_alive $CHAN_SESSION"
    if backoff_blocked channels; then
      log "channels: session $CHAN_SESSION absent -- launching"
      launch_channels
    fi
  fi

  # 3) DAVE WATCHDOG (loose loop that revives agent-dave)
  ensure_dave_watchdog
  ensure_channel_watchdogs
  # 4) ROLE-AGENT WATCHDOGS (Forge/Gauge/Quill/Scout -- permanent, channel-less)
  ensure_agent_watchdogs
  # 5) TELEGRAM MCP-PIPE WATCHDOG (orchestrator pipe recovery -- reboot-persistent)
  ensure_pipe_watchdog
  # 6) TOKEN-OUTAGE AUTO-ACK WATCHER (usage-limit ack + queue capture/re-dispatch)
  ensure_token_outage_watch
  # 7) HIBIKI TOKEN-FREE DAILY PUSH (throttled; reboot-safe replacement for WSL cron)
  ensure_hibiki_push
  # 8) MEDIC BREAK-GLASS OPERATOR BOT (token-free recovery bot -- always-on, reboot-persistent)
  ensure_medic_watchdog
  # 9) LOCAL-OLLAMA HYBRID AGENTS (marveen-local/claudia-local -- gated by store/ollama-hybrid.enabled)
  ensure_ollama
  ensure_local_agent_watchdogs
  # 10) TAILNET-ONLY DASHBOARD REMOTE ACCESS (tailscaled + serve config reboot-persistence -- gated by store/tailscale-serve.enabled)
  ensure_tailscaled
  # 11) DELIVERY-ABANDONMENT SENTINEL CONSUMER (out-of-band escalation of dropped inter-agent msgs -- gated by store/delivery-sentinel-watch.enabled)
  ensure_delivery_sentinel_watch

  # 12) DELIVERY ACK-OVERDUE CONSUMER (out-of-band escalation of unconfirmed ack_expected msgs -- gated by store/delivery-ack-watch.enabled)
  ensure_delivery_ack_watch
  # 13) IDLE-NUDGE WATCHDOG (obligation-driven resume nudge for stalled agents -- gated by store/idle-nudge-watch.enabled + Thor 845750ad)
  ensure_idle_nudge_watch
  # 14) CLI VERSION WATCH (pane-detector baseline alert on Claude Code upgrade -- card b1739f30)
  ensure_cli_version_watch
}

# --- main ------------------------------------------------------------------
# Guard the daemon so the file can be `source`d by tests (which only want the
# function + variable definitions above, never the lock + tick loop). When run
# directly, BASH_SOURCE[0] == $0 and the daemon runs as before.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  # Single instance: hold an flock for the lifetime of the process. Dry-run is
  # read-only (no side effects), so it skips the lock and can be run for
  # inspection while the real daemon holds it.
  if [ "$DRY_RUN" -eq 0 ]; then
    exec 9>"$LOCK"
    if ! flock -n 9; then
      echo "another fleet-supervisor is already running (lock $LOCK held)" >&2
      exit 0
    fi
  fi

  [ "$DRY_RUN" -eq 1 ] && log "starting in DRY-RUN mode (no side effects)"

  if [ "$ONCE" -eq 1 ]; then
    tick
    exit 0
  fi

  log "fleet-supervisor up (tick=${TICK_SECONDS}s, main=$MAIN_AGENT_ID)"
  while true; do
    tick
    sleep "$TICK_SECONDS"
  done
fi
