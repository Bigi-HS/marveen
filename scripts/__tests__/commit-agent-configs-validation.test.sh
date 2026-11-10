#!/usr/bin/env bash
# Tests for the securityProfile validation added to scripts/commit-agent-configs.sh
# (W3 follow-up, card 54638a53).
#
# Strategy: each test creates a minimal isolated fake INSTALL_DIR under a temp
# directory (with agents/, templates/profiles/, and a stub git) so the script
# can run without touching the real repo or performing real git operations.
#
# Decision: a config with a missing securityProfile causes exit 1 (fail-closed).
# Rationale: a missing profile is indistinguishable from a misconfigured or
# copy-pasted stub config; fail-closed is the safer default for a security gate.
#
# Run: bash scripts/__tests__/commit-agent-configs-validation.test.sh
set -u

INSTALL_DIR_REAL="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$INSTALL_DIR_REAL/scripts/commit-agent-configs.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$(( FAIL + 1 )); }

# ---------------------------------------------------------------------------
# Helper: create a minimal fake INSTALL_DIR with:
#   agents/<name>/agent-config.json  (content = $3)
#   templates/profiles/              (populated unless $4 = "empty")
#   bin/git                          (stub that does nothing)
# Returns the path to the created dir via stdout.
# ---------------------------------------------------------------------------
make_env() {
    local base="$1" agent_name="$2" config_json="$3" profiles_mode="${4:-normal}"

    local env_dir="$base/env_${agent_name}"
    mkdir -p "$env_dir/agents/$agent_name" "$env_dir/templates/profiles" "$env_dir/bin"

    # Write agent config
    printf '%s\n' "$config_json" > "$env_dir/agents/$agent_name/agent-config.json"

    # Populate profiles (unless empty mode)
    if [ "$profiles_mode" != "empty" ]; then
        echo '{}' > "$env_dir/templates/profiles/default.json"
        echo '{}' > "$env_dir/templates/profiles/developer-senior.json"
        echo '{}' > "$env_dir/templates/profiles/developer-junior.json"
        echo '{}' > "$env_dir/templates/profiles/researcher.json"
        echo '{}' > "$env_dir/templates/profiles/marketer.json"
    fi

    # Stub git: succeeds silently for all operations (add, diff, commit)
    cat > "$env_dir/bin/git" <<'EOF'
#!/usr/bin/env bash
# Stub git for tests: add/commit succeed; diff --cached --quiet => 0 (no staged changes)
case "$1" in
    add)    exit 0 ;;
    diff)   exit 0 ;;   # --quiet exits 0 = no diff = nothing to commit
    commit) exit 0 ;;
    *)      exit 0 ;;
esac
EOF
    chmod +x "$env_dir/bin/git"

    echo "$env_dir"
}

# Run the script in a given env dir; returns its exit code, captures stderr.
run_script() {
    local env_dir="$1"
    PATH="$env_dir/bin:$PATH" INSTALL_DIR="$env_dir" bash "$SCRIPT" 2>&1
}

# ---------------------------------------------------------------------------
# Test 1: a config with a valid securityProfile should pass (exit 0)
# ---------------------------------------------------------------------------
echo "Test 1: valid securityProfile -> passes"
ENV1=$(make_env "$WORK" "agent-valid" '{"securityProfile":"developer-senior","model":"claude-opus-4-5"}')
out1=$(run_script "$ENV1"); rc1=$?
if [ "$rc1" -eq 0 ]; then
    pass "valid profile exits 0"
else
    fail "valid profile should exit 0, got $rc1; output: $out1"
fi
if echo "$out1" | grep -q "securityProfile validation passed"; then
    pass "valid profile prints validation-passed message"
else
    fail "expected 'validation passed' in output; got: $out1"
fi

# ---------------------------------------------------------------------------
# Test 2: a config with an unknown (non-existent) securityProfile should exit 1
# ---------------------------------------------------------------------------
echo "Test 2: unknown securityProfile -> exit 1"
ENV2=$(make_env "$WORK" "agent-bad-profile" '{"securityProfile":"super-admin-turbo","model":"claude-opus-4-5"}')
out2=$(run_script "$ENV2"); rc2=$?
if [ "$rc2" -ne 0 ]; then
    pass "unknown profile exits non-zero"
else
    fail "unknown profile should exit non-zero, got 0; output: $out2"
fi
if echo "$out2" | grep -q "not found in"; then
    pass "unknown profile prints informative error"
else
    fail "expected 'not found in' in output; got: $out2"
fi

# ---------------------------------------------------------------------------
# Test 3: a config missing the securityProfile field entirely should exit 1
# (fail-closed: absent = unvalidated = blocked)
# ---------------------------------------------------------------------------
echo "Test 3: missing securityProfile field -> exit 1"
ENV3=$(make_env "$WORK" "agent-no-profile" '{"model":"claude-opus-4-5","displayName":"NoProfile Agent"}')
out3=$(run_script "$ENV3"); rc3=$?
if [ "$rc3" -ne 0 ]; then
    pass "missing securityProfile exits non-zero"
else
    fail "missing securityProfile should exit non-zero, got 0; output: $out3"
fi
if echo "$out3" | grep -qE "(no securityProfile|not found in)"; then
    pass "missing securityProfile prints informative error"
else
    fail "expected error message for missing field; got: $out3"
fi

# ---------------------------------------------------------------------------
# Test 4: empty templates/profiles/ skips validation and exits 0
# ---------------------------------------------------------------------------
echo "Test 4: empty templates/profiles/ -> skip validation, exit 0"
ENV4=$(make_env "$WORK" "agent-no-profiles-dir" '{"securityProfile":"whatever","model":"x"}' "empty")
out4=$(run_script "$ENV4"); rc4=$?
if [ "$rc4" -eq 0 ]; then
    pass "empty profiles dir exits 0 (graceful degradation)"
else
    fail "empty profiles dir should exit 0, got $rc4; output: $out4"
fi
if echo "$out4" | grep -q "WARNING"; then
    pass "empty profiles dir prints WARNING"
else
    fail "expected WARNING in output; got: $out4"
fi

# ---------------------------------------------------------------------------
# Test 5: missing templates/profiles/ directory skips validation, exits 0
# ---------------------------------------------------------------------------
echo "Test 5: missing templates/profiles/ directory -> skip validation, exit 0"
ENV5=$(make_env "$WORK" "agent-missing-dir" '{"securityProfile":"whatever","model":"x"}' "empty")
rmdir "$ENV5/templates/profiles"
rmdir "$ENV5/templates"
out5=$(run_script "$ENV5"); rc5=$?
if [ "$rc5" -eq 0 ]; then
    pass "missing profiles directory exits 0 (graceful degradation)"
else
    fail "missing profiles dir should exit 0, got $rc5; output: $out5"
fi
if echo "$out5" | grep -q "WARNING"; then
    pass "missing profiles directory prints WARNING"
else
    fail "expected WARNING for missing profiles dir; got: $out5"
fi

# ---------------------------------------------------------------------------
# Test 6: multiple configs where one is valid and one has an unknown profile
#         -> exit 1 and both errors reported
# ---------------------------------------------------------------------------
echo "Test 6: mixed valid+invalid configs in same run -> exit 1"
ENV6="$WORK/env_multi"
mkdir -p "$ENV6/agents/good-agent" "$ENV6/agents/bad-agent" \
         "$ENV6/templates/profiles" "$ENV6/bin"
echo '{"securityProfile":"default"}' > "$ENV6/agents/good-agent/agent-config.json"
echo '{"securityProfile":"nonexistent-profile"}' > "$ENV6/agents/bad-agent/agent-config.json"
echo '{}' > "$ENV6/templates/profiles/default.json"
cat > "$ENV6/bin/git" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$ENV6/bin/git"
out6=$(PATH="$ENV6/bin:$PATH" INSTALL_DIR="$ENV6" bash "$SCRIPT" 2>&1); rc6=$?
if [ "$rc6" -ne 0 ]; then
    pass "mixed configs with one invalid -> exits non-zero"
else
    fail "mixed configs should exit non-zero, got 0; output: $out6"
fi
if echo "$out6" | grep -q "nonexistent-profile"; then
    pass "mixed configs error message names the bad profile"
else
    fail "expected bad profile name in error; got: $out6"
fi

# ---------------------------------------------------------------------------
echo
if [ "$FAIL" -gt 0 ]; then
    echo "FAILED ($FAIL)"
    exit 1
fi
echo "ALL PASS"
