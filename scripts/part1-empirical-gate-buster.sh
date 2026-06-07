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
# note -> stderr so functions can return a result on stdout without the progress
# lines polluting a $(...) capture.
note() { echo "GATE: $*" >&2; }

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
    OBSERVE="$ROOT/scripts/_part1-gate-observe.py"
    [ -f "$OBSERVE" ] || fail "observe helper missing ($OBSERVE)"
    : > "$MARKER" || true; rm -f "$FIRED_FLAG" || true
    note "marker cleared"

    observe_reply() { python3 "$OBSERVE" --since "$1" 2>/dev/null; }

    # run_pass LABEL MODE(stop|kill) -> echoes "<outcome>:<hook_fired>" on stdout.
    # The v1 flaw fixed here: instead of SIGCONT after a fixed 90s (which let the
    # reply land on a resumed, healthy child and SUCCEED), we HOLD the wedge and
    # use the transcript to (a) confirm the reply is actually CALLED while wedged,
    # then (b) classify its terminal state -- failed / success / HANG (no result).
    run_pass() {
      local label="$1" mode="$2" child since state called=no outcome=hang fired=no
      child="$(resolve_one_child)" || { echo "no-child:no"; return 0; }
      note "[$label] buster bun child = PID $child (ancestry); mode=$mode"
      rm -f "$FIRED_FLAG" || true
      since="$(date +%s)"
      if [ "$mode" = stop ]; then
        kill -STOP "$child" 2>/dev/null || { note "[$label] SIGSTOP failed"; echo "stop-failed:no"; return 0; }
      else
        kill "$child" 2>/dev/null || true; sleep 2
        kill -0 "$child" 2>/dev/null && kill -9 "$child" 2>/dev/null || true
      fi
      trigger_buster_reply >&2 || true
      sleep 5; case "$(observe_reply "$since")" in STATE=none*) trigger_buster_reply >&2 || true;; esac

      note "[$label] waiting for Buster to CALL reply (<=150s)..."
      for _ in $(seq 1 30); do
        sleep 5; state="$(observe_reply "$since")"
        case "$state" in STATE=none*) : ;; *) called=yes; break ;; esac
      done
      if [ "$called" != yes ]; then
        [ "$mode" = stop ] && kill -CONT "$child" 2>/dev/null || true
        note "[$label] OUTCOME=no-call -- Buster never called reply (inconclusive)"
        echo "no-call:no"; return 0
      fi

      note "[$label] reply CALLED ($state). Holding wedge, polling terminal state (<=90s)..."
      for _ in $(seq 1 18); do
        sleep 5; state="$(observe_reply "$since")"
        case "$state" in
          STATE=failed*)  outcome=failed;  break ;;
          STATE=success*) outcome=success; break ;;
        esac
      done
      [ "$mode" = stop ] && kill -CONT "$child" 2>/dev/null || true
      [ -f "$FIRED_FLAG" ] && fired=yes
      note "[$label] OUTCOME=$outcome HOOK_FIRED=$fired ($state)"
      [ -s "$MARKER" ] && { note "[$label] marker payload:"; tail -n 2 "$MARKER" | sed 's/^/GATE:   /' >&2; }
      echo "$outcome:$fired"; return 0
    }

    note "=== WEDGE pass (SIGSTOP = alive-but-unresponsive) ==="
    WEDGE="$(run_pass WEDGE stop)"
    sleep 5
    note "=== CONTRAST pass (child KILL = child-gone) ==="
    KILLP="$(run_pass KILL kill)"

    echo
    note "VERDICT  wedge=$WEDGE  child_kill=$KILLP   (format outcome:hook_fired)"
    note "Interpretation: failed:yes -> PostToolUseFailure FIRES on a failed reply (hook detector viable). failed:no -> fires-not (transcript-tail). hang:* -> wedge HANGS the call, NO failure event -> hook CANNOT fire -> transcript-tail / hang-detector (conclusive). success/no-call -> inconclusive, retry."
    note "marker: $MARKER  | Report to marveen, then: $0 restore (+ Armorer revert Buster)"
    ;;

  restore)
    [ -f "$BACKUP" ] || fail "no backup found ($BACKUP)"
    cp -a "$BACKUP" "$SETTINGS" && rm -f "$BACKUP"
    note "restored settings.json from backup. Have Armorer revert Buster (c12 revert) to finish cleanup."
    ;;

  *)
    echo "usage: $0 {setup|run|restore}" >&2; exit 2 ;;
esac
