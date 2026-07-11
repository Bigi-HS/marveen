#!/bin/bash
# Tests for ensure_ollama in scripts/fleet-supervisor.sh (card 573d4595).
#
# WHY: the Ollama daemon serves the memory-embedding backend (nomic-embed-text @
# localhost:11434, src/noa-memory.ts) which is CORE always-on infra -- the
# heartbeat reembed-backfill and semantic recall depend on it. It was previously
# started only when store/ollama-hybrid.enabled was set (the flag for the
# OPTIONAL local-LLM agents marveen-local/claudia-local). That coupled a core
# capability's auto-start to an unrelated optional feature: with the flag absent
# (the normal state) a reboot left Ollama down and every embedding silently
# failed (0711 reboot: reembed aborted=true, succeeded=0/4).
#
# The fix decouples them: ensure_ollama starts the daemon UNCONDITIONALLY and
# idempotently (embeddings need it regardless of the hybrid flag), while
# ensure_local_agent_watchdogs stays flag-gated (the optional agents remain
# inert until an operator touches the flag).
#
# The daemon is exercised behaviorally with stubbed ollama/curl on an isolated
# PATH so it never touches the live box, plus source-contract asserts.
#
# Run: bash scripts/test_ensure_ollama_autostart.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUPERVISOR="$ROOT/scripts/fleet-supervisor.sh"
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

TMP="$(mktemp -d)"
BIN="$TMP/bin"
mkdir -p "$BIN"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# Stub ollama: `ollama serve` touches a marker so we can observe a start attempt.
cat > "$BIN/ollama" <<'EOF'
#!/bin/bash
[ "${1:-}" = "serve" ] && : > "$OLLAMA_START_MARKER"
exit 0
EOF
chmod +x "$BIN/ollama"

# Stub curl: the /api/tags liveness probe. Exit code = $STUB_CURL_RC (default 1
# = daemon down, so ensure_ollama proceeds to start).
cat > "$BIN/curl" <<'EOF'
#!/bin/bash
exit "${STUB_CURL_RC:-1}"
EOF
chmod +x "$BIN/curl"

export PATH="$BIN:$PATH"

# Source the supervisor for its function defs (the main-daemon block is guarded
# by BASH_SOURCE==$0, so nothing runs). Then point INSTALL_DIR/STORE at the
# sandbox so the flag check and log writes stay isolated.
# shellcheck disable=SC1090
. "$SUPERVISOR"
# The supervisor pins PATH on source (line ~110); re-prepend the stub bin so our
# fake ollama/curl win over any real ones on the box.
export PATH="$BIN:$PATH"
INSTALL_DIR="$TMP"
STORE="$TMP/store"
mkdir -p "$INSTALL_DIR/store"
DRY_RUN=0
log() { :; }  # silence

MARKER="$TMP/started"
export OLLAMA_START_MARKER="$MARKER"

# Reset between cases: drop the marker and (optionally) the flag.
reset() { rm -f "$MARKER" "$INSTALL_DIR/store/ollama-hybrid.enabled"; }
started() { [ -e "$MARKER" ]; }

# --- 1. flag ABSENT + daemon down -> starts (the core regression) -----------
reset
STUB_CURL_RC=1 ensure_ollama
sleep 0.4
started && ok "flag absent + daemon down -> ensure_ollama starts (no longer hybrid-flag-gated)" \
        || bad "flag absent: ensure_ollama should start ollama even without ollama-hybrid.enabled"

# --- 2. idempotent: daemon already serving -> does NOT start ----------------
reset
STUB_CURL_RC=0 ensure_ollama
sleep 0.4
started && bad "already-serving: ensure_ollama must be idempotent (no second start)" \
        || ok "daemon already serving -> ensure_ollama is idempotent (no restart)"

# --- 3. flag PRESENT still starts (superset of old behavior) ----------------
reset
: > "$INSTALL_DIR/store/ollama-hybrid.enabled"
STUB_CURL_RC=1 ensure_ollama
sleep 0.4
started && ok "flag present + daemon down -> still starts (old behavior preserved)" \
        || bad "flag present: ensure_ollama should still start"
rm -f "$INSTALL_DIR/store/ollama-hybrid.enabled"

# --- 4. DRY_RUN -> no side effect ------------------------------------------
reset
DRY_RUN=1 STUB_CURL_RC=1 ensure_ollama
sleep 0.4
started && bad "dry-run: ensure_ollama must not start the daemon" \
        || ok "DRY_RUN=1 -> ensure_ollama logs only, no start"
DRY_RUN=0

# --- 5. binary missing -> graceful skip (return 0, no start) ----------------
reset
( PATH="$TMP/empty:$(dirname "$(command -v bash)")"; mkdir -p "$TMP/empty"
  # curl stub gone from PATH too -> the probe `curl` is absent; the daemon-down
  # path still reaches the `command -v ollama` guard which now fails.
  STUB_CURL_RC=1 ensure_ollama ) ; rc=$?
sleep 0.4
{ [ "$rc" -eq 0 ] && ! started; } \
  && ok "ollama binary missing -> graceful skip (return 0, no start)" \
  || bad "binary missing: expected clean skip (rc=$rc, started=$(started && echo yes || echo no))"

# --- 6. source-contract: nohup start still closes fd 9 (flock-leak guard) ----
ollama_body="$(sed -n '/^ensure_ollama()/,/^}/p' "$SUPERVISOR")"
printf '%s\n' "$ollama_body" | grep -q 'nohup ollama serve' \
  && printf '%s\n' "$ollama_body" | grep 'nohup ollama serve' | grep -q '9>&-' \
  && ok "contract: ensure_ollama's nohup start still carries 9>&- (no flock leak)" \
  || bad "contract: ensure_ollama nohup start missing 9>&-"

# --- 7. contract: ensure_ollama no longer early-returns on the hybrid flag ---
printf '%s\n' "$ollama_body" | grep -q 'ollama_hybrid_enabled' \
  && bad "contract: ensure_ollama still references ollama_hybrid_enabled (should be decoupled)" \
  || ok "contract: ensure_ollama no longer gates on ollama_hybrid_enabled"

# --- 8. contract: the OPTIONAL local agents stay flag-gated ------------------
watchdog_body="$(sed -n '/^ensure_local_agent_watchdogs()/,/^}/p' "$SUPERVISOR")"
printf '%s\n' "$watchdog_body" | grep -q 'ollama_hybrid_enabled || return 0' \
  && ok "contract: ensure_local_agent_watchdogs stays gated on ollama-hybrid.enabled" \
  || bad "contract: ensure_local_agent_watchdogs must remain flag-gated (optional agents inert)"

echo
echo "ensure_ollama-autostart: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
