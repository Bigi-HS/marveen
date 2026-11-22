#!/usr/bin/env bash
# verify-api-anything-mitigations.sh
# Post-deploy verification for api-anything M1/M2/MCP conditions (card 0393173c).
# Exit 0 = all checks pass. Exit 1 = one or more checks failed (deploy incomplete).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCOUT_CLAUDE="$REPO_ROOT/agents/scout/CLAUDE.md"
SCOUT_MCP="$REPO_ROOT/agents/scout/.mcp.json"

PASS=0
FAIL=0

check() {
    local label="$1"
    local result="$2"  # "ok" or "fail"
    local detail="$3"
    if [ "$result" = "ok" ]; then
        echo "  PASS  $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL  $label -- $detail"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== api-anything mitigation verify (card 0393173c) ==="
echo ""

# M1: untrusted-tag marker in scout CLAUDE.md
if [ -f "$SCOUT_CLAUDE" ]; then
    if grep -q "untrusted source=\"web:" "$SCOUT_CLAUDE" 2>/dev/null; then
        check "M1 untrusted-tag marker in agents/scout/CLAUDE.md" "ok" ""
    else
        check "M1 untrusted-tag marker in agents/scout/CLAUDE.md" "fail" \
            "grep for 'untrusted source=\"web:' returned nothing -- M1 not applied"
    fi
else
    check "M1 untrusted-tag marker in agents/scout/CLAUDE.md" "fail" \
        "file does not exist: $SCOUT_CLAUDE"
fi

# M2: no-action constraint marker in scout CLAUDE.md
if [ -f "$SCOUT_CLAUDE" ]; then
    if grep -q "No-action constraint\|no-action constraint\|api-anything result.*tilos\|tilos.*api-anything result" "$SCOUT_CLAUDE" 2>/dev/null; then
        check "M2 no-action constraint marker in agents/scout/CLAUDE.md" "ok" ""
    else
        check "M2 no-action constraint marker in agents/scout/CLAUDE.md" "fail" \
            "no-action constraint text not found -- M2 not applied"
    fi
else
    check "M2 no-action constraint marker in agents/scout/CLAUDE.md" "fail" \
        "file does not exist: $SCOUT_CLAUDE"
fi

# M2/M4: maxChars no-override constraint in scout CLAUDE.md
if [ -f "$SCOUT_CLAUDE" ]; then
    if grep -q "maxChars\|no-override\|SOHA ne adj meg.*maxChars\|maxChars.*SOHA" "$SCOUT_CLAUDE" 2>/dev/null; then
        check "M4 maxChars no-override constraint in agents/scout/CLAUDE.md" "ok" ""
    else
        check "M4 maxChars no-override constraint in agents/scout/CLAUDE.md" "fail" \
            "maxChars no-override constraint text not found -- M4 not applied"
    fi
else
    check "M4 maxChars no-override constraint in agents/scout/CLAUDE.md" "fail" \
        "file does not exist: $SCOUT_CLAUDE"
fi

# MCP wiring: api-anything entry in scout .mcp.json
if [ -f "$SCOUT_MCP" ]; then
    if grep -q "api-anything" "$SCOUT_MCP" 2>/dev/null; then
        check "MCP wiring: api-anything entry in agents/scout/.mcp.json" "ok" ""
    else
        check "MCP wiring: api-anything entry in agents/scout/.mcp.json" "fail" \
            "'api-anything' not found in .mcp.json -- MCP not wired"
    fi
else
    check "MCP wiring: api-anything entry in agents/scout/.mcp.json" "fail" \
        "file does not exist: $SCOUT_MCP"
fi

# M3 (MCP): --no-learn flag in .mcp.json args
if [ -f "$SCOUT_MCP" ]; then
    if grep -q "\-\-no-learn" "$SCOUT_MCP" 2>/dev/null; then
        check "M3 --no-learn flag in agents/scout/.mcp.json args" "ok" ""
    else
        check "M3 --no-learn flag in agents/scout/.mcp.json args" "fail" \
            "'--no-learn' not found in .mcp.json -- learn_site MCP tool not disabled"
    fi
else
    check "M3 --no-learn flag in agents/scout/.mcp.json args" "fail" \
        "file does not exist: $SCOUT_MCP"
fi

# M6: LOCAL_ONLY env in agent-config (versioned, sanity check)
AGENT_CONFIG="$REPO_ROOT/agents/scout/agent-config.json"
if [ -f "$AGENT_CONFIG" ]; then
    if grep -q "API_ANYTHING_LOCAL_ONLY" "$AGENT_CONFIG" 2>/dev/null; then
        check "M6 API_ANYTHING_LOCAL_ONLY in agents/scout/agent-config.json" "ok" ""
    else
        check "M6 API_ANYTHING_LOCAL_ONLY in agents/scout/agent-config.json" "fail" \
            "env var not found in agent-config.json"
    fi
else
    check "M6 API_ANYTHING_LOCAL_ONLY in agents/scout/agent-config.json" "fail" \
        "agent-config.json does not exist"
fi

# M8: API_ANYTHING_KEY in agent-config (placeholder acceptable, absence is not)
if [ -f "$AGENT_CONFIG" ]; then
    if grep -q "API_ANYTHING_KEY" "$AGENT_CONFIG" 2>/dev/null; then
        check "M8 API_ANYTHING_KEY in agents/scout/agent-config.json" "ok" ""
    else
        check "M8 API_ANYTHING_KEY in agents/scout/agent-config.json" "fail" \
            "API_ANYTHING_KEY not found in agent-config.json"
    fi
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
echo ""

if [ "$FAIL" -gt 0 ]; then
    echo "DEPLOY INCOMPLETE: $FAIL check(s) failed."
    echo "Apply steps from docs/api-anything-deploy-checklist.md, then re-run this script."
    exit 1
else
    echo "All checks passed. api-anything M1/M2/MCP mitigations are live."
    exit 0
fi
