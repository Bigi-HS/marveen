#!/bin/bash
# Standalone Telegram MCP-pipe watchdog for the MAIN orchestrator session.
#
# WHY a separate process (not just the in-dashboard channel-health-monitor):
# the orchestrator (marveen-channels) runs the native Telegram plugin as a
# `bun` MCP stdio child. A long OS sleep OR a dashboard-server restart kills
# that child and it does NOT respawn -- Genesis goes mute on Telegram until a
# human runs `/mcp`. The in-process monitor recovers the dashboard's OWN poller
# but not this child, and it dies together with the dashboard on a restart.
# This loop is independent of BOTH the orchestrator session AND the dashboard,
# so it survives a dashboard restart and can drive the recovery itself.
#
# Each 5-minute cycle calls the node CLI, which: probes the pipe (409-conflict
# = alive+polling, free slot / gone child = dead), drives /mcp recovery via the
# tested menu-navigation on a confirmed-dead pipe, and after 2 dead cycles
# (~10min) sends ONE fallback alert over a DIRECT Bot API call (never the dead
# pipe). Recovery events are appended to store/telegram-pipe-watchdog.log.
#
# Cadence is 5 min (300s) per Dominik's spec. The CLI itself is bounded
# (short-timeout probes), so the loop never wedges.

ROOT=/home/domin/marveen
LOG="$ROOT/store/telegram-pipe-watchdog.sh.log"
INTERVAL=300

# Curated PATH so node/tmux resolve the same way the supervisor launches them.
PATH_CURATED="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export PATH="$PATH_CURATED"
NODE="$(command -v node)"

# Operator chat for the fallback escalation alert (Dominik's chat).
export WATCHDOG_ALERT_CHAT_ID="${WATCHDOG_ALERT_CHAT_ID:-8643929442}"
export MARVEEN_ROOT="$ROOT"

log() { echo "$(date -Is) $*" >> "$LOG"; }
log "telegram-pipe-watchdog started (pid $$, interval ${INTERVAL}s)"

while true; do
  if [ -z "$NODE" ]; then
    log "ERROR: node not found on PATH -- skipping cycle"
  elif [ ! -f "$ROOT/dist/web/telegram-pipe-watchdog-cli.js" ]; then
    log "ERROR: CLI not built (dist/web/telegram-pipe-watchdog-cli.js missing) -- run npm run build"
  else
    # Bound the whole cycle so a hung probe cannot stall the loop.
    out="$(cd "$ROOT" && timeout 60 "$NODE" dist/web/telegram-pipe-watchdog-cli.js 2>>"$LOG")"
    log "cycle: ${out:-<no output / timeout>}"

    # SUB-AGENT sweep (card 31ab64fe Part 2): recover the channel sub-agents'
    # pipes too, but ONLY while the dashboard is DOWN (the CLI self-gates on
    # that; when the dashboard is up the in-process channel-health-monitor owns
    # per-agent recovery and a second driver would double-press the same /mcp
    # menu). Usually a fast no-op skip; bounded higher because a real
    # dashboard-down sweep probes several agents in sequence.
    if [ -f "$ROOT/dist/web/per-agent-pipe-watchdog-cli.js" ]; then
      sub="$(cd "$ROOT" && timeout 120 "$NODE" dist/web/per-agent-pipe-watchdog-cli.js 2>>"$LOG")"
      log "subagent-sweep: ${sub:-<no output / timeout>}"
    fi

    # HANG sweep (card 31ab64fe Part 1): recover a WEDGED socketpair (an MCP
    # tool_use that hangs with no tool_result) -- invisible to the liveness sweep
    # above and to the in-process monitor. Runs REGARDLESS of dashboard state
    # (no overlap), reads transcripts only, drives /mcp once per distinct hang.
    if [ -f "$ROOT/dist/web/per-agent-hang-cli.js" ]; then
      hang="$(cd "$ROOT" && timeout 120 "$NODE" dist/web/per-agent-hang-cli.js 2>>"$LOG")"
      log "hang-sweep: ${hang:-<no output / timeout>}"
    fi

    # CONTEXT-WINDOW sweep (card fleet-context-early-warning): per-agent context-%
    # early warning. The TUI statusline can't surface a ballooning session in a
    # detached agent pane, so this reads each running agent's transcript, turns it
    # into a % of the model window, and alerts the operator on Telegram when an
    # agent crosses the high-water mark. Read-only on agents (no kill/restart), so
    # it runs every cycle regardless of dashboard state, like the hang sweep.
    if [ -f "$ROOT/dist/web/context-window-cli.js" ]; then
      ctx="$(cd "$ROOT" && timeout 60 "$NODE" dist/web/context-window-cli.js 2>>"$LOG")"
      log "context-sweep: ${ctx:-<no output / timeout>}"
    fi
  fi
  sleep "$INTERVAL"
done
