#!/usr/bin/env bash
# wire-context7-agent.sh -- wire the context7 external MCP into ONE agent, with
# its mandatory PreToolUse logging hook. Tier-B External-MCP-Adoption-Policy gate
# (store/mcp-external-adoption-policy.md): context7 is allowed for Dave + Scout
# ONLY, and the logging hook is a PRECONDITION of the wiring (never an afterthought).
#
# This is DELIBERATELY NOT named install-*-hook.sh: scripts/sync-hooks.sh would
# auto-run such a script into the GLOBAL ~/.claude on every update, which would
# expose context7 to every agent. The policy hard-bans context7 for marveen/chad/
# claudia/applegate, so wiring must stay explicit and per-agent. The agent
# allowlist below enforces that ban in code.
#
# Idempotent: re-running is a no-op. Use --dry-run to preview without writing.
#
# Usage:
#   bash scripts/wire-context7-agent.sh <dave|scout> [--dry-run]
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_PATH="$INSTALL_DIR/scripts/hooks/context7_log.py"
MATCHER="mcp__context7__.*"

AGENT="${1:-}"
DRY_RUN=0
[ "${2:-}" = "--dry-run" ] && DRY_RUN=1

# --- Policy enforcement: only Dave and Scout may ever receive context7. ---
case "$AGENT" in
  dave|scout) ;;
  *)
    echo "❌ refusing: context7 is Tier-B allowed for 'dave' and 'scout' ONLY." >&2
    echo "   (marveen/chad/claudia/applegate are policy-banned; see store/mcp-external-adoption-policy.md)" >&2
    echo "   usage: bash scripts/wire-context7-agent.sh <dave|scout> [--dry-run]" >&2
    exit 1
    ;;
esac

SETTINGS="$INSTALL_DIR/agents/$AGENT/.claude/settings.json"
CLAUDE_JSON="$INSTALL_DIR/agents/$AGENT/.claude-config/.claude.json"

if [ ! -f "$HOOK_PATH" ]; then
  echo "❌ hook not found: $HOOK_PATH" >&2
  exit 1
fi
if [ ! -f "$SETTINGS" ]; then
  echo "❌ agent settings.json not found: $SETTINGS" >&2
  exit 1
fi
if [ ! -f "$CLAUDE_JSON" ]; then
  echo "❌ agent .claude.json not found: $CLAUDE_JSON" >&2
  exit 1
fi

echo "→ wiring context7 for '$AGENT'$([ "$DRY_RUN" = 1 ] && echo ' (dry-run)')"

# --- 1) PreToolUse logging hook into the agent settings.json (idempotent). ---
DRY_RUN="$DRY_RUN" MATCHER="$MATCHER" HOOK_PATH="$HOOK_PATH" python3 - "$SETTINGS" <<'PY'
import json, os, sys, tempfile

path = sys.argv[1]
matcher = os.environ["MATCHER"]
hook_path = os.environ["HOOK_PATH"]
dry = os.environ["DRY_RUN"] == "1"

with open(path, encoding="utf-8") as f:
    cfg = json.load(f)

hooks = cfg.setdefault("hooks", {})
pre = hooks.setdefault("PreToolUse", [])

# Already wired?
for m in pre:
    if m.get("matcher") == matcher:
        for h in m.get("hooks", []):
            if h.get("command", "").endswith("context7_log.py"):
                print("  ⊙ settings.json PreToolUse hook already present -- skip")
                sys.exit(0)

entry = {"matcher": matcher,
         "hooks": [{"type": "command",
                    "command": f"python3 {hook_path}",
                    "timeout": 10}]}
pre.append(entry)

if dry:
    print(f"  [dry-run] would add PreToolUse matcher '{matcher}' -> python3 {hook_path}")
    sys.exit(0)

# Atomic write, preserve mode.
mode = os.stat(path).st_mode & 0o777
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.chmod(tmp, mode)
os.replace(tmp, path)
print(f"  ✓ settings.json PreToolUse hook added (matcher {matcher})")
PY

# --- 2) context7 MCP server into the agent's isolated .claude.json (idempotent). ---
# Top-level mcpServers in the PER-AGENT config dir scopes context7 to this agent
# only. We touch exactly one key and preserve everything else (incl. the file's
# 0600 mode and all credentials/history), writing atomically.
DRY_RUN="$DRY_RUN" python3 - "$CLAUDE_JSON" <<'PY'
import json, os, sys, tempfile

path = sys.argv[1]
dry = os.environ["DRY_RUN"] == "1"

with open(path, encoding="utf-8") as f:
    cfg = json.load(f)

servers = cfg.get("mcpServers")
if not isinstance(servers, dict):
    servers = {}

desired = {"command": "npx", "args": ["-y", "@upstash/context7-mcp"]}
if servers.get("context7") == desired:
    print("  ⊙ .claude.json mcpServers.context7 already present -- skip")
    sys.exit(0)

servers["context7"] = desired
cfg["mcpServers"] = servers

if dry:
    print("  [dry-run] would add mcpServers.context7 = npx -y @upstash/context7-mcp")
    sys.exit(0)

mode = os.stat(path).st_mode & 0o777
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.chmod(tmp, mode)
os.replace(tmp, path)
print("  ✓ .claude.json mcpServers.context7 added (npx -y @upstash/context7-mcp)")
PY

echo "✓ context7 wiring complete for '$AGENT'$([ "$DRY_RUN" = 1 ] && echo ' (dry-run, no writes)')"
echo "  reminder: 'use context7' is explicit-only (no auto-trigger); restart the agent session to load the MCP."
