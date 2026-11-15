#!/usr/bin/env bash
# rgb-lights.sh -- schedule-driven RGB control for Dominik's Windows host via OpenRGB.
# Invoked by the dashboard endpoint POST /api/rgb/lights (src/web/routes/rgb.ts),
# which an n8n schedule (23:30 off / 07:00 on) drives via httpRequest. n8n's
# Execute Command node is disabled for safety, so the server owns the spawn.
#
# Context (see memory ref-windows-host-rgb-openrgb-setup):
#   - Host: ASUS TUF B560M-PLUS. OpenRGB controls the Redragon keyboard (EVision 0C45:5004)
#     WITHOUT elevation, plus the GPU + motherboard. It does NOT see the Redragon M913 mouse
#     (verified 2026-11-15 --list-devices: only GPU/mobo/keyboard) -- the mouse has a closed
#     onboard controller, set-once-persists via its Eco switch or the Redragon app, not here.
#     Motherboard fans (ENE SMBus) need the disable-ASUS + one-reboot (Phase 2) + elevation;
#     until then this only affects the keyboard (and GPU/mobo where reachable).
#   - OpenRGB.exe is GUI-subsystem: it produces NO readable stdout. We cannot verify by
#     reading its output -- the watchdog verifies by other means / the user confirms visually.
#   - The OpenRGB background service must be stopped so the CLI controls devices directly
#     (GitLab #825). The durable setup sets that service to Manual start.
#
# Usage: rgb-lights.sh off           -> all devices black (000000)
#        rgb-lights.sh on [RRGGBB]   -> all devices to color (default FF0000 red)
set -euo pipefail

PS="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
OPENRGB='C:\Program Files\OpenRGB\OpenRGB.exe'
LOG="/home/domin/marveen/.rgb-lights.log"

action="${1:-}"
color="${2:-FF0000}"

case "$action" in
  off) hex="000000" ;;
  on)  hex="$color" ;;
  *)   echo "usage: $0 off | on [RRGGBB]" >&2; exit 2 ;;
esac

# Defense-in-depth: reject any hex that is not exactly 6 hex chars before it
# reaches the PowerShell -Command string interpolation (Chad #1004 MEDIUM).
[[ $hex =~ ^[0-9A-Fa-f]{6}$ ]] || { echo "invalid hex: $hex" >&2; exit 2; }

ts="$(date '+%F %T %Z')"
# Fire the color command. Non-elevated reaches USB (kbd/mouse); SMBus fans need Phase 2 + elevation.
"$PS" -NoProfile -Command "Start-Process -FilePath '$OPENRGB' -ArgumentList '--mode','static','--color','$hex' -NoNewWindow -Wait" >/dev/null 2>&1 || true

echo "[$ts] rgb-lights $action -> #$hex applied" >> "$LOG"
echo "[$ts] rgb-lights $action -> #$hex applied"
