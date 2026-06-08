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
# FLEET_ROOT overrides the install root (tests point it at a temp dir). Defaults
# to the repo this file lives in (scripts/lib/ -> up two).

_fleet_root="${FLEET_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)}"
_fleet_env="$_fleet_root/store/fleet-oauth.env"
_fleet_tok="$_fleet_root/store/.claude-oauth-token"

if [ -r "$_fleet_env" ]; then
  # The env-file is `CLAUDE_CODE_OAUTH_TOKEN=<tok>`; auto-export while sourcing.
  set -a
  # shellcheck disable=SC1090
  . "$_fleet_env"
  set +a
elif [ -r "$_fleet_tok" ]; then
  _fleet_t="$(tr -d '\r\n' < "$_fleet_tok" 2>/dev/null)"
  [ -n "$_fleet_t" ] && export CLAUDE_CODE_OAUTH_TOKEN="$_fleet_t"
  unset _fleet_t
fi

unset _fleet_root _fleet_env _fleet_tok
