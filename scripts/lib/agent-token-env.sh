# agent-token-env.sh -- source (do not execute) before launching `claude` in a
# fleet agent tmux session. Mirrors scripts/lib/fleet-oauth-env.sh, but for the
# DASHBOARD bearer (credential B), not the Anthropic OAuth token (credential A).
#
# Exports GENESIS_AGENT_TOKEN -- the agent's OWN per-agent dashboard token (card
# b1ce5118) -- so its curl/python calls to the local dashboard authenticate AS
# that agent and the server can DERIVE its identity from the credential instead
# of trusting a self-asserted `from` field.
#
# The token VALUE is only read from a 0600 file into the process environment; it
# is never echoed, logged, or written anywhere by this helper.
#
# NO-OP (leaves the environment untouched -> the agent falls back to whatever
# bearer it already uses, i.e. the shared token) in every degraded case:
#   - GENESIS_AGENT_ID unset, or the token file absent / unreadable.
#   - the token file is a SYMLINK (Chad #4 MEDIUM): a same-user peer could point
#     one agent's token path at a sibling's (admin) token; following it would
#     hand this agent the wrong, higher-privileged identity. Refuse symlinks.
#   - the token is malformed (not 64-char hex).
#   - the token has EXPIRED (Chad #3): the file carries an absolute expiry; once
#     past it we fall back rather than export a token the server will 401, so a
#     long-lived agent degrades to the shared bearer instead of going dark.
# This "fail-open for availability" matches fleet-oauth-env.sh: a token problem
# never breaks a launch.
#
# Token file: $FLEET_ROOT/agents/<GENESIS_AGENT_ID>/.genesis-token, two lines:
#   line 1: the raw 64-char hex token
#   line 2: absolute expiry as epoch SECONDS (empty = non-expiring)
#
# FLEET_ROOT overrides the install root (tests point it at a temp dir). Defaults
# to the repo this file lives in (scripts/lib/ -> up two). GENESIS_AGENT_ID names
# the agent whose token to load; the launch path sets it.

_at_root="${FLEET_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)}"
_at_agent="${GENESIS_AGENT_ID:-}"
_at_file=""
_at_tok=""
_at_exp=""

if [ -n "$_at_agent" ]; then
  _at_file="$_at_root/agents/$_at_agent/.genesis-token"
fi

if [ -n "$_at_file" ] && [ -e "$_at_file" ]; then
  if [ -L "$_at_file" ]; then
    # Read-side symlink guard (Chad #4). Do NOT follow; fall back to the shared
    # bearer. The warning names the path but never a token value.
    echo "agent-token-env: token file is a symlink, ignoring (shared-bearer fallback): $_at_file" >&2
  elif [ -r "$_at_file" ]; then
    # Read at most two lines; strip CR. The value never leaves these locals.
    { IFS= read -r _at_l1 || true; IFS= read -r _at_l2 || true; } < "$_at_file" 2>/dev/null
    _at_tok="$(printf '%s' "${_at_l1:-}" | tr -d '\r')"
    _at_exp="$(printf '%s' "${_at_l2:-}" | tr -d '\r')"
    unset _at_l1 _at_l2
  fi
fi

# Export ONLY a well-formed, unexpired token; treat anything else as absent.
if [[ "$_at_tok" =~ ^[0-9a-f]{64}$ ]]; then
  _at_now="$(date +%s)"
  if [ -n "$_at_exp" ] && [[ "$_at_exp" =~ ^[0-9]+$ ]] && [ "$_at_now" -ge "$_at_exp" ]; then
    echo "agent-token-env: token expired, shared-bearer fallback" >&2
  else
    export GENESIS_AGENT_TOKEN="$_at_tok"
  fi
fi

unset _at_root _at_agent _at_file _at_tok _at_exp _at_now
