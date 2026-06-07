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

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STORE="$INSTALL_DIR/store"
LOG="$STORE/fleet-supervisor.log"
LOCK="$STORE/.fleet-supervisor.lock"
STATE_DIR="$STORE/.fleet-supervisor"

TICK_SECONDS=60
SETTLE_SECONDS=8            # how long a freshly launched component must survive
RETRY_BASE_SECONDS=30       # first backoff after a rapid failure
RETRY_MAX_SECONDS=$((30*60))  # cap: token-exhaustion long-wait

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
  run "$TMUX_BIN" new-session -d -s "$DASH_SESSION" -c "$INSTALL_DIR" \
      "export PATH=\"$PATH\" && exec $NODE dist/index.js"
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
  for n in gauge quill scout applegate; do
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
  for n in forge chad thor claudia; do
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

# --- one supervision pass --------------------------------------------------
# Keep every sub-agent's OAuth credentials a symlink to the single main token
# ($HOME/.claude/.credentials.json), which auto-refreshes. A sub-agent's Claude
# can refresh via atomic-rename, which silently replaces the symlink with a
# standalone file -- it then drifts to its own expiry and prompts for re-auth
# (the dave/thor outage on 2026-06-05). Reconcile every tick so it self-heals.
reconcile_agent_creds() {
  local main="$HOME/.claude/.credentials.json"
  [ -e "$main" ] || return 0
  local f
  for f in "$INSTALL_DIR"/agents/*/.claude-config/.credentials.json; do
    [ -e "$f" ] || continue
    # Already the correct symlink? leave it.
    if [ -L "$f" ] && [ "$(readlink "$f")" = "$main" ]; then
      continue
    fi
    # Drifted into a standalone file -- back up once, then re-link.
    if [ ! -L "$f" ]; then
      cp -a "$f" "$f.drift-$(date +%Y%m%d-%H%M%S)" 2>/dev/null
      log "creds: $(basename "$(dirname "$(dirname "$f")")") drifted to standalone file -- re-linking to main token"
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
}

# --- main ------------------------------------------------------------------
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
