#!/bin/bash
# Adversarial fixtures for the transport-liveness dual-gate in
# scripts/channel-watchdog.sh (card edc8b7f8).
#
# WHAT IS UNDER TEST: the new gate 3.5. When .channel-keepalive is stale (a
# TUI-liveness signal that ALSO ages on token-starvation of a perfectly healthy
# transport), the watchdog must consult a token-free transport-liveness marker
# (store/.channel-transport-alive, stamped by the 409 probe) plus a token-free
# transcript wedge discriminator (last inbound ingestion vs last assistant
# activity) BEFORE respawning. Decision matrix:
#
#   transport-alive (marker fresh) AND no pending inbound  -> SKIP respawn
#         (token-starved idle TUI -- the bug being fixed)
#   transport-alive AND pending unprocessed inbound        -> RESPAWN
#         (a genuinely wedged TUI -- detector stays sharp)
#   transport DEAD (marker stale/absent)                   -> RESPAWN
#         (existing recovery path, regardless of inbound state)
#
# Per adversarial-fixture-gate this ships the 3 required categories:
#   FP  = false-positive-idle : idle token-starved must NOT respawn
#   FN  = false-negative-wedge : a real wedge must NOT be swallowed by the skip
#   OPP = opposing-combination : transport-dead + idle -> the transport signal
#         dominates the idle signal, so it STILL respawns (proves the skip is
#         gated on transport-alive, not on idle alone).
#
# Same source-guard + stub-PATH harness as channel-watchdog.test.sh.
# Run: bash scripts/__tests__/channel-watchdog-transport-dualgate.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

# --- stub bin: tmux / curl / claude ---------------------------------------
STUBBIN="$TMP/bin"; mkdir -p "$STUBBIN"
RESPAWN_LOG="$TMP/respawn.log"; : > "$RESPAWN_LOG"
cat > "$STUBBIN/tmux" <<EOF
#!/bin/bash
case "\$1" in
  has-session) [ "\${STUB_HAS_SESSION:-1}" = "1" ] && exit 0 || exit 1 ;;
  respawn-pane) echo "respawn-pane \$*" >> "$RESPAWN_LOG"; exit 0 ;;
  *) exit 0 ;;
esac
EOF
cat > "$STUBBIN/curl" <<'EOF'
#!/bin/bash
echo "${STUB_DASH_CODE:-000}"
EOF
cat > "$STUBBIN/claude" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$STUBBIN/tmux" "$STUBBIN/curl" "$STUBBIN/claude"
export PATH="$STUBBIN:$PATH"

# --- isolated store + transcript dir --------------------------------------
export CHANNEL_WATCHDOG_STORE="$TMP/store"; mkdir -p "$CHANNEL_WATCHDOG_STORE"
export CHANNEL_WATCHDOG_TRANSCRIPT_DIR="$TMP/transcript"; mkdir -p "$CHANNEL_WATCHDOG_TRANSCRIPT_DIR"
KA="$CHANNEL_WATCHDOG_STORE/.channel-keepalive"
MARKER="$CHANNEL_WATCHDOG_STORE/.channel-transport-alive"
STAMP="$CHANNEL_WATCHDOG_STORE/.channel-last-respawn"
COUNT="$CHANNEL_WATCHDOG_STORE/.channel-watchdog-respawns"
JSONL="$CHANNEL_WATCHDOG_TRANSCRIPT_DIR/session.jsonl"

# shellcheck disable=SC1090
source "$INSTALL_DIR/scripts/channel-watchdog.sh"

CAPTURE="$TMP/log.txt"; : > "$CAPTURE"
log() { echo "$*" >> "$CAPTURE"; }

now=$(date +%s)
stale_at=$(( now - 20 * 60 ))   # keepalive 20 min old => past STALE_SECONDS (15 min)

# ISO-8601 UTC (matches Claude Code transcript timestamps). $1 = seconds ago.
iso_ago() { date -u -d "@$(( now - $1 ))" '+%Y-%m-%dT%H:%M:%S.000Z'; }

# Write a transcript whose last inbound / last assistant lines carry the given
# ISO timestamps. Empty string => omit that line entirely.
write_transcript() {
  local in_iso="$1" as_iso="$2"
  : > "$JSONL"
  [ -n "$as_iso" ] && echo "{\"type\":\"assistant\",\"timestamp\":\"$as_iso\"}" >> "$JSONL"
  [ -n "$in_iso" ] && echo "{\"type\":\"user\",\"timestamp\":\"$in_iso\",\"message\":\"<channel source=telegram>hi</channel>\"}" >> "$JSONL"
}

reset_state() {
  : > "$RESPAWN_LOG"; : > "$CAPTURE"
  rm -f "$KA" "$MARKER" "$JSONL" "$STAMP" "$COUNT"
  touch -d "@$stale_at" "$KA"   # every fixture starts with a STALE keepalive
}

echo "== FP: false-positive-idle -> token-starved idle, transport alive, MUST NOT respawn =="
reset_state
touch "$MARKER"                                  # transport marker fresh (now)
write_transcript "$(iso_ago 900)" "$(iso_ago 300)"  # inbound 15m ago, assistant 5m ago => processed/idle
STUB_HAS_SESSION=1 STUB_DASH_CODE=000 run_once
if [ -s "$RESPAWN_LOG" ]; then fail "FP: idle token-starved MUST NOT respawn"; else pass "FP: idle token-starved -> no respawn"; fi
grep -qi "skip" "$CAPTURE" && pass "FP: skip logged" || fail "FP: skip logged"

echo "== FN: false-negative-wedge -> transport alive BUT pending inbound, MUST respawn =="
reset_state
touch "$MARKER"                                  # transport marker fresh
write_transcript "$(iso_ago 120)" "$(iso_ago 900)"  # inbound 2m ago > assistant 15m ago => WEDGE
STUB_HAS_SESSION=1 STUB_DASH_CODE=000 run_once
grep -q "respawn-pane -k -t" "$RESPAWN_LOG" && pass "FN: pending-inbound wedge -> respawn issued" || fail "FN: pending-inbound wedge -> respawn issued"

echo "== OPP: opposing-combination -> transport DEAD + idle, transport dominates, MUST respawn =="
reset_state
# marker STALE (transport dead) but transcript looks idle (no pending inbound).
touch -d "@$(( now - 30 * 60 ))" "$MARKER"
write_transcript "$(iso_ago 900)" "$(iso_ago 300)"  # idle
STUB_HAS_SESSION=1 STUB_DASH_CODE=000 run_once
grep -q "respawn-pane -k -t" "$RESPAWN_LOG" && pass "OPP: transport-dead + idle -> respawn (transport signal dominates)" || fail "OPP: transport-dead + idle -> respawn"

echo "== OPP-b: marker ABSENT (never stamped) + idle -> transport unknown => respawn =="
reset_state
# no MARKER file at all
write_transcript "$(iso_ago 900)" "$(iso_ago 300)"
STUB_HAS_SESSION=1 STUB_DASH_CODE=000 run_once
grep -q "respawn-pane -k -t" "$RESPAWN_LOG" && pass "OPP-b: no marker -> respawn" || fail "OPP-b: no marker -> respawn"

echo "== SAFETY: transport alive but transcript UNREADABLE -> fail-safe respawn (no false skip) =="
reset_state
touch "$MARKER"                                  # transport alive
rm -f "$JSONL"                                   # no transcript => cannot prove idle
STUB_HAS_SESSION=1 STUB_DASH_CODE=000 run_once
grep -q "respawn-pane -k -t" "$RESPAWN_LOG" && pass "SAFETY: unknown transcript -> respawn (no false skip)" || fail "SAFETY: unknown transcript -> respawn"

echo "== INVARIANT: GATE 0 dashboard UP still short-circuits (dual-gate never consulted) =="
reset_state
touch "$MARKER"
write_transcript "$(iso_ago 120)" "$(iso_ago 900)"   # would be a wedge...
STUB_HAS_SESSION=1 STUB_DASH_CODE=200 run_once        # ...but dashboard is UP
if [ -s "$RESPAWN_LOG" ]; then fail "INVARIANT: dash up MUST NOT respawn"; else pass "INVARIANT: dash up -> no respawn (GATE 0 wins)"; fi

echo
if [ "$FAIL" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "$FAIL FAILED"; exit 1; fi
