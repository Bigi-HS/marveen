# fleet-oauth-env.sh -- source (do not execute) before launching `claude` in any
# fleet agent tmux session.
#
# Exports CLAUDE_CODE_OAUTH_TOKEN from the canonical fleet setup-token so every
# agent authenticates off the static ~1-year `sk-ant-oat01-...` bearer. That env
# var OVERRIDES a stale/standalone ~/.claude/.credentials.json (measured
# 2026-06-08, see store/medic-setuptoken-checklist.md), which is exactly the
# drift-discard / re-auth outage class this migration retires: an agent whose
# .credentials.json has diverged still authenticates as long as this env var is
# set at launch.
#
# Source precedence (first readable wins):
#   1. store/fleet-oauth.env   -- the Medic-maintained env-file
#                                 (CLAUDE_CODE_OAUTH_TOKEN=<tok>), 0600. Medic's
#                                 `token-refresh` keeps it in lockstep with the
#                                 canonical token.
#   2. store/.claude-oauth-token -- the raw canonical token file (single line,
#                                 0600). Fallback so a fresh box works before
#                                 Medic has ever run token-refresh.
#
# No-op (leaves the environment untouched) when neither file is present/readable,
# so an agent on a box without a setup-token simply falls back to whatever creds
# it already had -- this never breaks a launch.
#
# The token VALUE is only read from a 0600 file into the process environment; it
# is never echoed, logged, or written anywhere by this helper.
#
# The env-file is STRICT-PARSED (grep for the single CLAUDE_CODE_OAUTH_TOKEN=
# line), never `source`d, so a malformed or hostile env-file can never execute
# arbitrary code in the launch shell. The extracted value is shape-validated
# against the canonical bearer pattern; anything else is treated as absent. This
# mirrors the TS reader in src/fleet-oauth-token.ts (TOKEN_RE) exactly, so the
# bash launch path and the SDK launch path agree on what counts as a valid token.
#
# FLEET_ROOT overrides the install root (tests point it at a temp dir). Defaults
# to the repo this file lives in (scripts/lib/ -> up two).

_fleet_root="${FLEET_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)}"
_fleet_env="$_fleet_root/store/fleet-oauth.env"
_fleet_tok="$_fleet_root/store/.claude-oauth-token"
_fleet_t=""

if [ -r "$_fleet_env" ]; then
  # Strict-parse: pull the first CLAUDE_CODE_OAUTH_TOKEN= line WITHOUT sourcing.
  # grep returns the literal line (CR stripped); the value is everything after
  # the first '=', with one layer of surrounding matching quotes removed.
  _fleet_line="$(grep -m1 '^[[:space:]]*CLAUDE_CODE_OAUTH_TOKEN=' "$_fleet_env" 2>/dev/null | tr -d '\r')"
  if [ -n "$_fleet_line" ]; then
    _fleet_t="${_fleet_line#*=}"
    case "$_fleet_t" in
      \"*\") _fleet_t="${_fleet_t#\"}"; _fleet_t="${_fleet_t%\"}" ;;
      \'*\') _fleet_t="${_fleet_t#\'}"; _fleet_t="${_fleet_t%\'}" ;;
    esac
    # An env-file token line is authoritative (matches the TS reader): even if its
    # value turns out malformed it does NOT fall through to the raw token file.
    _fleet_have_line=1
  fi
  unset _fleet_line
fi

if [ -z "${_fleet_have_line:-}" ] && [ -r "$_fleet_tok" ]; then
  _fleet_t="$(tr -d '\r\n' < "$_fleet_tok" 2>/dev/null)"
fi

# Export ONLY a well-formed bearer; treat anything else as absent (no export, so
# a pre-existing env value or symlinked .credentials.json stays in effect). Shape
# mirrors TOKEN_RE in src/fleet-oauth-token.ts.
if [[ "$_fleet_t" =~ ^sk-ant-[A-Za-z0-9_-]{20,200}$ ]]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$_fleet_t"
fi

unset _fleet_root _fleet_env _fleet_tok _fleet_t _fleet_have_line
