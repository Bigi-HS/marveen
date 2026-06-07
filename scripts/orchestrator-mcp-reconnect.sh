#!/bin/bash
# On-demand orchestrator Telegram MCP auto-reconnect after a deploy/restart.
#
# WHY this exists (the post-deploy "Genesis elnemulas" gap):
# A dashboard-server restart (the `marveen` tmux session, the deploy step in the
# fleet-deploy-verify skill) kills the orchestrator's (marveen-channels) OWN
# Telegram MCP `bun` stdio child. The fleet-deploy-verify skill step 5 spells out
# the TWO DISTINCT TELEGRAM PIPES:
#   (a) the DASHBOARD server's IN-PROCESS channel-monitor poller -- the
#       channel-health-monitor (item3) auto-reconnects THIS one server-side.
#   (b) the ORCHESTRATOR session's OWN Telegram MCP stdio child -- the pipe the
#       `reply` tool uses. item3 does NOT recover (b); the bun child does not
#       self-respawn, so after a deploy Genesis stays MUTE on Telegram until a
#       human runs `/mcp` by hand.
# The periodic telegram-pipe-watchdog (scripts/telegram-pipe-watchdog.sh) does
# heal (b) eventually, but only on its 5-minute cadence -- so a deploy leaves a
# window of up to ~5 min where Genesis cannot send its own success report. This
# script CLOSES that window: it is the on-demand, deploy-triggered counterpart,
# meant to be run RIGHT AFTER the restart (manually, or by whoever owns the
# deploy) to self-heal pipe (b) immediately instead of waiting for the next
# watchdog tick.
#
# DETECTION SIGNAL (delegated, not reinvented):
# It reuses the SAME tested decision + recovery core as the periodic watchdog by
# invoking dist/web/telegram-pipe-watchdog-cli.js once per attempt. That CLI:
#   - probes the orchestrator's OWN pipe via the Telegram 409-Conflict signal
#     (409 = native poller holds the getUpdates slot = alive+polling; a clean
#     200 across retries = slot free = dead) plus a bot.pid/ps presence check,
#   - on a confirmed-dead verdict drives RECOVERY through the tested /mcp-menu
#     navigation (attemptChannelMcpReconnect) in the marveen-channels session,
#   - emits a one-line `verdict=... recovered=... ...` status we parse here.
# We do NOT duplicate that logic; we only orchestrate WHEN it runs (a tight
# post-deploy poll loop) versus the periodic loop's fixed cadence.
#
# RECOVERY MECHANISM:
# Each attempt runs one CLI cycle (which itself performs the /mcp reconnect on a
# dead pipe), then re-probes. The MCP child takes a few seconds to come back up
# after a /mcp, so we attempt up to MAX_ATTEMPTS times with ATTEMPT_GAP between
# them, stopping as soon as a cycle reports the pipe healthy (verdict=healthy).
# A clean exit 0 means the pipe is healthy; exit 1 means it was still not
# healthy after all attempts (escalate -- run /mcp by hand in marveen-channels).
#
# SCOPE (per kanban card mcp-reco): self-contained, NOT wired into
# fleet-supervisor / fleet-boot, and it does NOT touch live sessions itself --
# all session interaction is the already-tested CLI's /mcp navigation. Run it
# explicitly as the last beat of a deploy.
#
# Usage:
#   scripts/orchestrator-mcp-reconnect.sh            # run the post-deploy heal
#   MAX_ATTEMPTS=8 scripts/orchestrator-mcp-reconnect.sh
#
# Recovery events are appended to store/telegram-pipe-watchdog.log by the CLI;
# this script's own progress goes to store/orchestrator-mcp-reconnect.log.

set -uo pipefail

ROOT=/home/domin/marveen
LOG="$ROOT/store/orchestrator-mcp-reconnect.log"
CLI="dist/web/telegram-pipe-watchdog-cli.js"

# How many CLI cycles to try, and how long to wait between them. The MCP child
# needs a few seconds to re-register after a /mcp, so we re-probe with a gap
# rather than declaring failure on the first still-dead read.
MAX_ATTEMPTS="${MAX_ATTEMPTS:-6}"
ATTEMPT_GAP="${ATTEMPT_GAP:-15}"
# Per-cycle bound so one wedged probe can't stall the whole heal.
CYCLE_TIMEOUT="${CYCLE_TIMEOUT:-60}"

# Curated PATH so node/tmux resolve the same way the supervisor launches them
# (matches scripts/telegram-pipe-watchdog.sh and the fleet-deploy-verify skill).
PATH_CURATED="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export PATH="$PATH_CURATED"
NODE="$(command -v node)"

# Operator chat for the CLI's fallback escalation alert (Dominik's chat), and
# the project root the CLI reads its state/token paths from.
export WATCHDOG_ALERT_CHAT_ID="${WATCHDOG_ALERT_CHAT_ID:-8643929442}"
export MARVEEN_ROOT="$ROOT"

log() { echo "$(date -Is) $*" >> "$LOG"; }

if [ -z "$NODE" ]; then
  log "ERROR: node not found on PATH -- cannot run reconnect"
  echo "orchestrator-mcp-reconnect: node not found on PATH" >&2
  exit 2
fi
if [ ! -f "$ROOT/$CLI" ]; then
  log "ERROR: CLI not built ($CLI missing) -- run npm run build"
  echo "orchestrator-mcp-reconnect: $CLI missing -- run npm run build" >&2
  exit 2
fi

log "post-deploy reconnect started (pid $$, max_attempts=$MAX_ATTEMPTS gap=${ATTEMPT_GAP}s)"

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
  out="$(cd "$ROOT" && timeout "$CYCLE_TIMEOUT" "$NODE" "$CLI" 2>>"$LOG")"
  log "attempt $attempt/$MAX_ATTEMPTS: ${out:-<no output / timeout>}"
  echo "attempt $attempt/$MAX_ATTEMPTS: ${out:-<no output / timeout>}"

  # The CLI prints `verdict=healthy ...` once the orchestrator pipe is alive and
  # polling again. That is our success signal -- stop as soon as we see it.
  case "$out" in
    *verdict=healthy*)
      log "pipe healthy -- orchestrator MCP recovered after $attempt attempt(s)"
      echo "orchestrator-mcp-reconnect: pipe healthy after $attempt attempt(s)"
      exit 0
      ;;
  esac

  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    sleep "$ATTEMPT_GAP"
  fi
  attempt=$((attempt + 1))
done

log "pipe NOT healthy after $MAX_ATTEMPTS attempts -- escalate: run /mcp in marveen-channels"
echo "orchestrator-mcp-reconnect: still not healthy after $MAX_ATTEMPTS attempts -- run /mcp in the marveen-channels session" >&2
exit 1
