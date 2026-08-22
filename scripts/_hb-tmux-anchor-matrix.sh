#!/usr/bin/env bash
# Measure how each tmux subcommand handles the `=` exact-match anchor against an
# EXISTING session. The axis that matters is the failure mode: silent (rc=0 with
# empty/no effect) vs loud (rc!=0 with a message).
set -uo pipefail

S=zzmatrix
tmux kill-session -t "=$S" 2>/dev/null
tmux new-session -d -s "$S" 'sleep 120'

probe() { # name, then command words
  local name=$1; shift
  local out rc
  out=$("$@" 2>&1); rc=$?
  printf '  %-16s rc=%-3s out=%s\n' "$name" "$rc" "$(printf '%s' "${out:-<empty>}" | head -c 60 | tr '\n' ' ')"
}

echo "tmux $(tmux -V | awk '{print $2}') -- target '=$S' on an EXISTING session"
probe has-session     tmux has-session     -t "=$S"
probe list-windows    tmux list-windows    -t "=$S" -F '#{window_id}'
probe list-panes      tmux list-panes      -t "=$S" -F '#{pane_id}'
probe display-message tmux display-message -p -t "=$S" '#{session_created}'  # tmux-anchor-lint: ignore -- measurement tool: intentionally tests bare =NAME pane-target form
probe capture-pane    tmux capture-pane    -p -t "=$S"  # tmux-anchor-lint: ignore -- measurement tool: intentionally tests bare =NAME pane-target form
probe send-keys       tmux send-keys       -t "=$S" ''  # tmux-anchor-lint: ignore -- measurement tool: intentionally tests bare =NAME pane-target form
echo "  (kill-session tested last -- it is destructive)"
probe kill-session    tmux kill-session    -t "=$S"

tmux kill-session -t "=$S" 2>/dev/null
echo "done"
