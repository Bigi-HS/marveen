#!/bin/bash
# Tests for scripts/lib/fleet-oauth-env.sh -- the launch-time OAuth env injector.
#
# Each case sources the helper in a SUBSHELL with FLEET_ROOT pointed at a fresh
# temp dir, then asserts the resulting CLAUDE_CODE_OAUTH_TOKEN. The token VALUE
# is never printed -- only PASS/FAIL and equality verdicts -- so this harness is
# safe to run anywhere and its output can be logged.
#
# Run: bash scripts/test_fleet_oauth_env.sh
set -u

HELPER="$(cd "$(dirname "$0")/.." && pwd)/scripts/lib/fleet-oauth-env.sh"
FAKE="sk-ant-oat01-$(printf 'Z%.0s' {1..95})"   # realistic-shaped, entirely fake
PASS=0
FAIL=0

ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

# Run the helper with a given temp root, echo back only whether the var matches
# the expected value. Never prints the token itself.
# args: <root> <expected: FAKE|EMPTY>
check() {
  local root="$1" expect="$2" desc="$3"
  local got
  got="$(FLEET_ROOT="$root" bash -c '. "$0"; printf "%s" "${CLAUDE_CODE_OAUTH_TOKEN:-}"' "$HELPER")"
  case "$expect" in
    FAKE)  [ "$got" = "$FAKE" ] && ok "$desc" || bad "$desc (var not set to expected token)" ;;
    EMPTY) [ -z "$got" ]        && ok "$desc" || bad "$desc (var unexpectedly set)" ;;
  esac
}

mkroot() { local d; d="$(mktemp -d)"; mkdir -p "$d/store"; printf '%s' "$d"; }

# 1) fleet-oauth.env present -> exported.
R="$(mkroot)"; printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$FAKE" > "$R/store/fleet-oauth.env"
check "$R" FAKE "fleet-oauth.env is sourced and exported"
rm -rf "$R"

# 2) only raw token file -> exported (fallback).
R="$(mkroot)"; printf '%s\n' "$FAKE" > "$R/store/.claude-oauth-token"
check "$R" FAKE "raw .claude-oauth-token fallback is exported"
rm -rf "$R"

# 3) raw token with trailing CR/LF -> stripped.
R="$(mkroot)"; printf '%s\r\n' "$FAKE" > "$R/store/.claude-oauth-token"
check "$R" FAKE "raw token trailing CR/LF is stripped"
rm -rf "$R"

# 4) both present -> fleet-oauth.env wins (precedence). Put a DIFFERENT value in
#    the raw file; success means the env-file value is the one exported.
R="$(mkroot)"
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$FAKE" > "$R/store/fleet-oauth.env"
printf '%s\n' "sk-ant-oat01-DIFFERENT$(printf 'Q%.0s' {1..80})" > "$R/store/.claude-oauth-token"
check "$R" FAKE "fleet-oauth.env takes precedence over raw token"
rm -rf "$R"

# 5) neither present -> no-op (var stays empty).
R="$(mkroot)"
check "$R" EMPTY "no token files -> launch env untouched"
rm -rf "$R"

# 6) helper must not CLOBBER an already-set var when no files exist (no-op leaves
#    a pre-existing env value alone).
R="$(mkroot)"
got="$(FLEET_ROOT="$R" CLAUDE_CODE_OAUTH_TOKEN="$FAKE" \
       bash -c '. "$0"; printf "%s" "${CLAUDE_CODE_OAUTH_TOKEN:-}"' "$HELPER")"
[ "$got" = "$FAKE" ] && ok "no-op preserves a pre-existing env value" \
  || bad "no-op preserves a pre-existing env value (it was altered)"
rm -rf "$R"

# 7) STRICT-PARSE SECURITY: a command substitution on the token line must NOT
#    execute (the old `set -a; . file` would have run it). Value is rejected by
#    the shape gate, and the side-effect marker must be absent.
R="$(mkroot)"
printf 'CLAUDE_CODE_OAUTH_TOKEN=$(touch "%s/PWNED")\n' "$R" > "$R/store/fleet-oauth.env"
check "$R" EMPTY "hostile cmd-subst on token line is rejected (not exported)"
[ ! -e "$R/PWNED" ] && ok "hostile cmd-subst created no side effect (not executed)" \
  || bad "hostile cmd-subst EXECUTED (PWNED marker created)"
rm -rf "$R"

# 8) STRICT-PARSE SECURITY: an extra shell line in the env-file must NOT execute;
#    the valid token line is still parsed.
R="$(mkroot)"
{ printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$FAKE"; printf 'touch "%s/PWNED2"\n' "$R"; } > "$R/store/fleet-oauth.env"
check "$R" FAKE "valid token parsed even when env-file has extra lines"
[ ! -e "$R/PWNED2" ] && ok "extra shell line in env-file is not executed" \
  || bad "extra shell line EXECUTED (PWNED2 marker created)"
rm -rf "$R"

# 9) malformed env-file token is rejected by the shape gate AND, being an
#    authoritative token line, does NOT fall through to the raw token file
#    (mirrors src/fleet-oauth-token.ts).
R="$(mkroot)"
printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "not-a-valid-token" > "$R/store/fleet-oauth.env"
printf '%s\n' "$FAKE" > "$R/store/.claude-oauth-token"
check "$R" EMPTY "malformed env-file token rejected, no fall-through to raw token"
rm -rf "$R"

# 10) double-quoted env-file value is unquoted and exported.
R="$(mkroot)"
printf 'CLAUDE_CODE_OAUTH_TOKEN="%s"\n' "$FAKE" > "$R/store/fleet-oauth.env"
check "$R" FAKE "double-quoted env-file value is unquoted and exported"
rm -rf "$R"

# 11) single-quoted env-file value is unquoted and exported.
R="$(mkroot)"
printf "CLAUDE_CODE_OAUTH_TOKEN='%s'\n" "$FAKE" > "$R/store/fleet-oauth.env"
check "$R" FAKE "single-quoted env-file value is unquoted and exported"
rm -rf "$R"

# 12) env-file with NO token line (other keys only) falls through to the raw
#     token file.
R="$(mkroot)"
printf 'SOME_OTHER_KEY=1\n' > "$R/store/fleet-oauth.env"
printf '%s\n' "$FAKE" > "$R/store/.claude-oauth-token"
check "$R" FAKE "env-file without a token line falls through to raw token"
rm -rf "$R"

# 13) leading whitespace before the key is tolerated.
R="$(mkroot)"
printf '   CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$FAKE" > "$R/store/fleet-oauth.env"
check "$R" FAKE "leading whitespace before the key is tolerated"
rm -rf "$R"

# 14) malformed RAW token file is rejected by the shape gate (the TS reader
#     shape-validates the raw file too).
R="$(mkroot)"
printf '%s\n' "garbage-not-a-bearer" > "$R/store/.claude-oauth-token"
check "$R" EMPTY "malformed raw token is rejected by the shape gate"
rm -rf "$R"

# 15) SECURITY: this harness never emitted the token value on stdout/stderr. We
#    re-run all checks capturing combined output and grep for the fake value.
leak="$(
  R="$(mkroot)"; printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$FAKE" > "$R/store/fleet-oauth.env"
  check "$R" FAKE "leak-probe" 2>&1
  rm -rf "$R"
)"
if printf '%s' "$leak" | grep -qF "$FAKE"; then
  bad "token value must never appear in helper/test output"
else
  ok "token value never appears in output"
fi

echo "----"
echo "fleet-oauth-env: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
