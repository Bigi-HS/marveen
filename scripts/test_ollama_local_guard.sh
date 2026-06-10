#!/bin/bash
# Tests for scripts/lib/ollama-local-guard.sh -- the launch-time guard logic for
# the local-Ollama agents (marveen-local / claudia-local, card ollama-hybrid).
#
# The guard lib is the FATAL-guard for a local agent: it must (1) read the model
# strictly with NO claude-sonnet fallback (a cloud model on ANTHROPIC_BASE_URL=
# localhost:11434 is a dead/token-burning agent), (2) dual-check the model
# (negative: never cloud/empty; positive: must be an allowlisted Ollama model),
# (3) verify the Ollama daemon actually serves an allowlisted model before a
# session is launched, and (4) decide context-saturation restarts adaptively.
#
# Every function here is pure (no daemon/tmux IO) so it runs anywhere. The live
# `olg_ollama_ready` curl wrapper is exercised via its pure core olg_tags_have_allowed.
#
# Run: bash scripts/test_ollama_local_guard.sh
set -u

LIB="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/ollama-local-guard.sh"
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

# shellcheck disable=SC1090
. "$LIB"

tmpcfg() { local d; d="$(mktemp)"; printf '%s' "$1" > "$d"; printf '%s' "$d"; }

# ---- olg_read_model: strict, no fallback -----------------------------------
C="$(tmpcfg '{"model":"qwen3:4b","displayName":"GenesisLocal"}')"
out="$(olg_read_model "$C")"; rc=$?
{ [ "$rc" -eq 0 ] && [ "$out" = "qwen3:4b" ]; } && ok "read_model: valid config prints model" || bad "read_model: valid config (got rc=$rc out='$out')"
rm -f "$C"

out="$(olg_read_model "/no/such/file.json" 2>/dev/null)"; rc=$?
{ [ "$rc" -ne 0 ] && [ -z "$out" ]; } && ok "read_model: missing file -> nonzero, empty (NO sonnet fallback)" || bad "read_model: missing file (got rc=$rc out='$out')"

C="$(tmpcfg 'not json at all {{{')"
out="$(olg_read_model "$C" 2>/dev/null)"; rc=$?
{ [ "$rc" -ne 0 ] && [ -z "$out" ]; } && ok "read_model: unparseable json -> nonzero, empty" || bad "read_model: unparseable (got rc=$rc out='$out')"
rm -f "$C"

C="$(tmpcfg '{"displayName":"x"}')"
out="$(olg_read_model "$C" 2>/dev/null)"; rc=$?
{ [ "$rc" -ne 0 ] && [ -z "$out" ]; } && ok "read_model: no model field -> nonzero, empty" || bad "read_model: no model field (got rc=$rc out='$out')"
rm -f "$C"

C="$(tmpcfg '{"model":""}')"
out="$(olg_read_model "$C" 2>/dev/null)"; rc=$?
{ [ "$rc" -ne 0 ] && [ -z "$out" ]; } && ok "read_model: empty model -> nonzero, empty" || bad "read_model: empty model (got rc=$rc out='$out')"
rm -f "$C"

# ---- olg_model_allowed: dual-check (negative + positive) -------------------
olg_model_allowed "qwen3:4b"   && ok "model_allowed: qwen3:4b allowed"            || bad "model_allowed: qwen3:4b should be allowed"
olg_model_allowed "qwen2.5:7b" && ok "model_allowed: qwen2.5:7b fallback allowed" || bad "model_allowed: qwen2.5:7b should be allowed"
olg_model_allowed "qwen3:8b"   && ok "model_allowed: qwen3:8b allowed"            || bad "model_allowed: qwen3:8b should be allowed"

olg_model_allowed ""                  2>/dev/null && bad "model_allowed: empty must be rejected"            || ok "model_allowed: empty rejected"
olg_model_allowed "claude-sonnet-4-6" 2>/dev/null && bad "model_allowed: cloud model must be rejected"      || ok "model_allowed: claude-sonnet-4-6 rejected (negative guard)"
olg_model_allowed "claude-opus-4-8"   2>/dev/null && bad "model_allowed: any claude-* must be rejected"     || ok "model_allowed: claude-opus-4-8 rejected (negative guard)"
olg_model_allowed "llama3:8b"         2>/dev/null && bad "model_allowed: off-allowlist must be rejected"    || ok "model_allowed: llama3:8b rejected (positive guard)"
olg_model_allowed "MISSING"           2>/dev/null && bad "model_allowed: MISSING sentinel must be rejected" || ok "model_allowed: MISSING sentinel rejected"

# ---- olg_tags_have_allowed: pure core of the Ollama health check -----------
J='{"models":[{"name":"qwen3:4b"},{"name":"nomic-embed-text:latest"}]}'
olg_tags_have_allowed "$J" && ok "tags_have_allowed: qwen3:4b present -> ready" || bad "tags_have_allowed: qwen3:4b should be ready"

J='{"models":[{"name":"qwen3:4b-instruct-q4_k_m"}]}'
olg_tags_have_allowed "$J" && ok "tags_have_allowed: substring match (qwen3:4b in tag)" || bad "tags_have_allowed: substring match should pass"

J='{"models":[{"name":"llama3:8b"},{"name":"mistral:7b"}]}'
olg_tags_have_allowed "$J" 2>/dev/null && bad "tags_have_allowed: only off-allowlist must fail" || ok "tags_have_allowed: only off-allowlist models -> not ready"

J='{"models":[]}'
olg_tags_have_allowed "$J" 2>/dev/null && bad "tags_have_allowed: empty models must fail" || ok "tags_have_allowed: empty models -> not ready"

olg_tags_have_allowed "garbage not json" 2>/dev/null && bad "tags_have_allowed: malformed json must fail" || ok "tags_have_allowed: malformed json -> not ready"

# ---- olg_should_restart: adaptive context% + 8h fallback -------------------
# args: <context_pct> <started_at_epoch> <now_epoch>
olg_should_restart 85 1000 1100 && ok "should_restart: context 85% > 80% -> restart"            || bad "should_restart: 85% should restart"
olg_should_restart 50 1000 1100 2>/dev/null && bad "should_restart: 50% fresh must NOT restart" || ok "should_restart: context 50% fresh -> no restart"
olg_should_restart 80 1000 1100 2>/dev/null && bad "should_restart: exactly 80% must NOT restart (spec: >80)" || ok "should_restart: exactly 80% -> no restart"
olg_should_restart 81 1000 1100 && ok "should_restart: 81% -> restart (strict >80)" || bad "should_restart: 81% should restart"
# 8h fallback: now - started > 28800
olg_should_restart 0 1000 30000 && ok "should_restart: 0% but 8h+ elapsed -> fallback restart" || bad "should_restart: 8h fallback should restart"
olg_should_restart 50 1000 4600 2>/dev/null && bad "should_restart: 50% + 1h must NOT restart" || ok "should_restart: 50% + 1h elapsed -> no restart"
# non-numeric context (API unreachable -> empty) must not crash; fresh -> no restart, old -> fallback
olg_should_restart "" 1000 1100 2>/dev/null && bad "should_restart: empty ctx fresh must NOT restart" || ok "should_restart: empty/non-numeric ctx fresh -> no restart (no crash)"
olg_should_restart "" 1000 30000 && ok "should_restart: empty ctx + 8h -> fallback restart still fires" || bad "should_restart: empty ctx 8h fallback should restart"

echo "----"
echo "ollama-local-guard: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
