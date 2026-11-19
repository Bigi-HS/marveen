#!/bin/bash
# Fleet session selector for ttyd web-terminal (card 78f0375e)
# Presents running tmux sessions; user picks one to view.
# Read-only or writable depending on how ttyd is launched (no -W = readonly).

echo "NoA Fleet Session Viewer"
echo "========================"
echo ""

sessions=$(tmux list-sessions -F "#{session_name}" 2>/dev/null | sort)
if [ -z "$sessions" ]; then
    echo "No tmux sessions found. Is the fleet running?"
    sleep 5
    exit 1
fi

echo "$sessions" | nl -w3 -s ')  '
echo ""
printf "Session number (q=quit): "
read -r choice

case "$choice" in
    q|Q) exit 0 ;;
    ''|*[!0-9]*)
        echo "Invalid. Enter a number."
        sleep 2
        exec "$0"
        ;;
esac

session=$(echo "$sessions" | sed -n "${choice}p")
if [ -z "$session" ]; then
    echo "No session at index $choice."
    sleep 2
    exec "$0"
fi

echo "Attaching: $session"
exec tmux attach -t "$session"
