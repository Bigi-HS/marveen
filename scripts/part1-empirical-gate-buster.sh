#!/bin/bash
# Part 1 EMPIRICAL GATE (card 4525ff36) -- answers ONE question on c12 Buster
# before we commit the 2-3d Part 1 impl:
#
#   Does a PostToolUseFailure hook FIRE when an MCP `reply` call fails because the
#   Telegram MCP transport (bun stdio socketpair) is WEDGED -- and what payload?
#
# If YES -> Part 1 detector = the hook (writes a marker -> external watchdog runs
#          /mcp recovery; hooks cannot run /mcp themselves -- spike-confirmed).
# If NO  -> plan B = transcript-tail detector (watchdog tails the agent transcript
#          for the "text.length" pattern).
#
# Phases (hooks register at LAUNCH, and Armorer owns Buster launch, so this splits
# cleanly along that boundary):
#   setup    -- back up Buster settings.json + merge in the diagnostic
#               PostToolUseFailure hook (matcher mcp__.*). After this, agent-buster
#               must be (re)launched by Armorer so the hook registers.
#   run      -- with the hook-armed Buster live: wedge its bun child (SIGSTOP =
#               alive-but-unresponsive, the closest sim to a socketpair wedge),
#               trigger a Buster reply, and watch whether the diagnostic marker
#               appears. Then a contrast pass with child-KILL. Reports the verdict.
#   restore  -- restore Buster settings.json from the backup.
#
# HARD SAFETY (same invariants as the #50 sim):
#   * Buster's bun child is identified by PROCESS ANCESTRY (descendant of the
#     agent-buster pane), never a path/broad pattern. Aborts unless exactly one.
#   * SIGSTOP/SIGCONT/kill are PID-scoped to that one verified child. NEVER pkill -f.
#   * Touches ONLY Buster (sandbox). No live agent, no main session.
#
# Usage: scripts/part1-empirical-gate-buster.sh {setup|run|restore}

set -euo pipefail

ROOT=/home/domin/marveen
cd "$ROOT"
export MARVEEN_ROOT="$ROOT"
PATH_CURATED="/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export PATH="$PATH_CURATED"
NODE="$(command -v node)"; TMUXB="$(command -v tmux)"

BUSTER_SESSION="agent-buster"
BUN_TELEGRAM_RX="telegram.*--shell=bun.*start"
SETTINGS="$ROOT/agents/buster/.claude-config/settings.json"
BACKUP="$ROOT/agents/buster/.claude-config/settings.json.part1gate-bak"
HOOK_CMD="python3 $ROOT/scripts/hooks/_part1-gate-probe.py"
MARKER="$ROOT/store/part1-gate-marker.jsonl"
FIRED_FLAG="$ROOT/store/.part1-gate-hook-fired"
ALERT_CHAT="8643929442"

fail() { echo "GATE: FAIL -- $*" >&2; exit 1; }
note() { echo "GATE: $*"; }

is_descendant() {
  local pid="$1" ancestor="$2" guard=0 ppid
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ "$guard" -lt 64 ]; do
    [ "$pid" = "$ancestor" ] && return 0
    ppid="$(awk '/^PPid:/{print $2}' "/proc/$pid/status" 2>/dev/null)"
    [ -n "$ppid" ] || return 1
    pid="$ppid"; guard=$((guard + 1))
  done
  return 1
}
buster_pane_pid() { env -u TMUX "$TMUXB" list-panes -t "$BUSTER_SESSION" -F '#{pane_pid}' 2>/dev/null | head -1; }
buster_bun_children() {
  local pane="$1" p
  for p in $(pgrep -f "$BUN_TELEGRAM_RX" || true); do is_descendant "$p" "$pane" && echo "$p"; done
}

resolve_one_child() {
  local pane; pane="$(buster_pane_pid)"; [ -n "$pane" ] || fail "could not resolve agent-buster pane pid (buster not running?)"
  mapfile -t PIDS < <(buster_bun_children "$pane")
  [ "${#PIDS[@]}" -ne 0 ] || fail "no telegram bun child under agent-buster pane $pane (channel not provisioned / already dead)"
  [ "${#PIDS[@]}" -eq 1 ] || fail "expected exactly ONE buster bun child, found ${#PIDS[@]}: ${PIDS[*]} -- aborting"
  echo "${PIDS[0]}"
}

# --- trigger a Buster reply over the inter-agent path (Buster then calls its
# telegram reply tool, which is wedged). If Buster does not call reply on its
# own, fall back to a direct, explicit tmux-injected instruction.
trigger_buster_reply() {
  local tok; tok="$(cat "$ROOT/store/.dashboard-token" 2>/dev/null || true)"
  if [ -n "$tok" ]; then
    "$NODE" -e '
      const tok=process.argv[1];
      const body=JSON.stringify({from:"dave",to:"buster",content:"PIPE-TESZT (Part1 gate): kuldj MOST egy rovid uzenetet a sajat Telegram csatornadra a reply tool-lal. Ez egy szandekos pipe-teszt."});
      fetch("http://127.0.0.1:3420/api/messages",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+tok},body}).then(r=>r.text()).then(t=>console.log("trigger sent:",t)).catch(e=>console.log("trigger send failed:",e.message));
    ' "$tok" || note "WARN: inter-agent trigger send failed"
  else
    note "WARN: no dashboard token -- cannot send inter-agent trigger"
  fi
}

case "${1:-}" in
  setup)
    [ -f "$SETTINGS" ] || fail "Buster settings.json not found ($SETTINGS) -- provision Buster first (Armorer)"
    [ -f "$ROOT/scripts/hooks/_part1-gate-probe.py" ] || fail "diagnostic hook missing -- scripts/hooks/_part1-gate-probe.py"
    cp -a "$SETTINGS" "$BACKUP"
    note "backed up settings.json -> $BACKUP"
    "$NODE" -e '
      const fs=require("fs"); const f=process.argv[1]; const cmd=process.argv[2];
      const s=JSON.parse(fs.readFileSync(f,"utf-8")||"{}");
      s.hooks=s.hooks||{};
      s.hooks.PostToolUseFailure=[{matcher:"mcp__.*",hooks:[{type:"command",command:cmd}]}];
      fs.writeFileSync(f,JSON.stringify(s,null,2));
      console.log("installed PostToolUseFailure hook (matcher mcp__.*)");
    ' "$SETTINGS" "$HOOK_CMD"
    note "SETUP DONE. Now have Armorer (RE)LAUNCH agent-buster so the hook registers at startup, then run: $0 run"
    ;;

  run)
    [ -n "$NODE" ] || fail "node not on PATH"
    env -u TMUX "$TMUXB" has-session -t "$BUSTER_SESSION" 2>/dev/null || fail "$BUSTER_SESSION not running"
    grep -q "_part1-gate-probe.py" "$SETTINGS" 2>/dev/null || fail "hook not in settings.json -- run '$0 setup' + relaunch Buster first"
    : > "$MARKER" || true; rm -f "$FIRED_FLAG" || true
    note "marker cleared"

    CHILD="$(resolve_one_child)"; note "buster bun child = PID $CHILD (by ancestry)"

    # --- WEDGE pass: SIGSTOP = alive-but-unresponsive (closest to socketpair wedge)
    note "=== WEDGE pass (SIGSTOP child $CHILD) ==="
    kill -STOP "$CHILD" 2>/dev/null || fail "could not SIGSTOP $CHILD"
    sleep 1
    trigger_buster_reply
    note "waiting up to 90s for the reply to fail + the hook to fire..."
    WEDGE_FIRED=no
    for _ in $(seq 1 18); do
      sleep 5
      [ -f "$FIRED_FLAG" ] && { WEDGE_FIRED=yes; break; }
    done
    kill -CONT "$CHILD" 2>/dev/null || true
    note "child resumed (SIGCONT). WEDGE hook fired: $WEDGE_FIRED"
    [ "$WEDGE_FIRED" = yes ] && { note "wedge-pass marker payload:"; tail -n 3 "$MARKER" | sed 's/^/GATE:   /'; }

    # --- CONTRAST pass: child KILL (child gone). Re-resolve (may have respawned).
    note "=== CONTRAST pass (kill child = child-gone case) ==="
    rm -f "$FIRED_FLAG" || true
    sleep 3
    CHILD2="$(resolve_one_child || true)"
    if [ -n "${CHILD2:-}" ]; then
      kill "$CHILD2" 2>/dev/null || true; sleep 2
      kill -0 "$CHILD2" 2>/dev/null && kill -9 "$CHILD2" 2>/dev/null || true
      trigger_buster_reply
      note "waiting up to 60s for the kill-case hook to fire..."
      KILL_FIRED=no
      for _ in $(seq 1 12); do sleep 5; [ -f "$FIRED_FLAG" ] && { KILL_FIRED=yes; break; }; done
      note "CONTRAST (child-kill) hook fired: $KILL_FIRED"
    else
      note "WARN: no child to kill for contrast pass (skipped)"
      KILL_FIRED="n/a"
    fi

    echo
    note "VERDICT  HOOK_FIRES_ON_WEDGE=$WEDGE_FIRED  HOOK_FIRES_ON_CHILD_KILL=${KILL_FIRED:-n/a}"
    note "marker file: $MARKER (inspect payload for tool_result/error schema)"
    note "Report this verdict to marveen BEFORE the Part 1 impl. Then run: $0 restore  (and Armorer reverts Buster)"
    ;;

  restore)
    [ -f "$BACKUP" ] || fail "no backup found ($BACKUP)"
    cp -a "$BACKUP" "$SETTINGS" && rm -f "$BACKUP"
    note "restored settings.json from backup. Have Armorer revert Buster (c12 revert) to finish cleanup."
    ;;

  *)
    echo "usage: $0 {setup|run|restore}" >&2; exit 2 ;;
esac
