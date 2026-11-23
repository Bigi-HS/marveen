#!/bin/bash
# verify-boot-persistence.sh -- assert the WSL boot-persistence chain for the
# Genesis fleet is wired end to end (migration-readiness GAP G4).
#
# WSL has no systemd, so the fleet does NOT auto-start via a service manager.
# Reboot-persistence is achieved by a single /etc/wsl.conf [boot] command that
# runs scripts/fleet-boot.sh, which launches the always-on fleet-supervisor.sh,
# which in turn brings up (and keeps up) the dashboard, channels, and watchdogs.
# See docs/boot-persistence.md for the full chain and rationale.
#
# On a MIGRATION TARGET box this chain is the thing most likely to be silently
# missing (a git clone carries fleet-boot.sh + fleet-supervisor.sh, but NOT the
# root-owned /etc/wsl.conf). If it is missing, the fleet looks "migrated" but
# nothing resurrects a crashed agent after the first reboot. This script makes
# that failure LOUD and prints the exact remediation.
#
# Read-only: it changes nothing. Run it on the new box after migration.
#
# Usage: scripts/verify-boot-persistence.sh
#   exit 0 = chain fully wired; exit 1 = one or more links missing.

set -u
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FLEET_BOOT="$INSTALL_DIR/scripts/fleet-boot.sh"
SUPERVISOR="$INSTALL_DIR/scripts/fleet-supervisor.sh"
START_ALL="$INSTALL_DIR/scripts/start-fleet.sh"
WSL_CONF="/etc/wsl.conf"

FAIL=0
ok()   { echo "  OK   $1"; }
bad()  { echo "  MISS $1"; FAIL=1; }

echo "Boot-persistence verify (GAP G4)  install_dir=$INSTALL_DIR"
echo

# 1. The boot entrypoint and the engine it starts must exist and be runnable.
[ -f "$FLEET_BOOT" ] && ok "fleet-boot.sh present"            || bad "fleet-boot.sh MISSING ($FLEET_BOOT)"
[ -f "$SUPERVISOR" ] && ok "fleet-supervisor.sh present"      || bad "fleet-supervisor.sh MISSING ($SUPERVISOR)"
[ -f "$START_ALL"  ] && ok "start-fleet.sh (manual start-all) present" || bad "start-fleet.sh MISSING ($START_ALL)"

# 2. The WSL autostart hook. This is the root-owned, NON-git-tracked link that a
#    migration most often drops. Match on the fleet-boot path, not an exact
#    string, so a cosmetically-different but correct [boot] command still passes.
if [ -f "$WSL_CONF" ]; then
  if grep -q "fleet-boot.sh" "$WSL_CONF"; then
    ok "/etc/wsl.conf [boot] command points at fleet-boot.sh"
  else
    bad "/etc/wsl.conf exists but [boot] does NOT reference fleet-boot.sh"
  fi
else
  bad "/etc/wsl.conf MISSING -- no autostart hook (fleet will NOT survive a reboot)"
fi

# 3. Is the supervisor actually running right now? (informational -- a fresh box
#    before first boot legitimately has none; not a hard failure by itself.)
if pgrep -f "fleet-supervisor.sh" >/dev/null 2>&1; then
  ok "fleet-supervisor.sh is running now"
else
  echo "  WARN fleet-supervisor.sh not running now (expected before first boot;"
  echo "       start it by hand with: scripts/start-fleet.sh)"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "RESULT: boot-persistence chain fully wired."
  exit 0
fi

cat <<EOF
RESULT: boot-persistence chain INCOMPLETE. Remediate:

  # 1. Ensure the scripts exist (carried by the git clone):
  ls -l $FLEET_BOOT $SUPERVISOR $START_ALL

  # 2. Install the WSL [boot] autostart hook (needs root; NOT git-tracked).
  #    Append (or create) /etc/wsl.conf with:
  #      [boot]
  #      command = su - $USER -c '$FLEET_BOOT'
  #    then from Windows:  wsl --shutdown   (the [boot] command runs on next start)

  # 3. Or start the fleet now, without a reboot:
  $START_ALL
EOF
exit 1
