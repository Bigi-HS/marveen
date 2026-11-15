#!/bin/bash
# Tests the hex guard added to scripts/rgb-lights.sh (Chad #1004 MEDIUM).
# Validates that a malicious or malformed $color is rejected before it reaches
# the PowerShell -Command string interpolation, while valid 6-hex values pass.
#
# The script uses an absolute PS path variable (not from PATH), so the stub
# powershell.exe is placed at that absolute path under a chroot-style WORK
# prefix, and the script is patched via a wrapper that overrides the PS var.
# For "no PS invocation" cases we rely on the exit code (guard exits 2 before
# the PS line is reached), which is deterministic and sufficient.
#
# Run: bash scripts/__tests__/rgb-lights.test.sh
set -u

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$INSTALL_DIR/scripts/rgb-lights.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAIL=0
pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# --- Stub powershell.exe: records invocation so we can prove it WAS or WAS NOT called.
# We override the PS variable by creating a wrapper script that sources the
# original after replacing the PS assignment.
PS_MARKER="$WORK/ps_invoked"
STUB_PS="$WORK/stub-ps.sh"
cat > "$STUB_PS" <<SH
#!/bin/bash
touch "$PS_MARKER"
exit 0
SH
chmod +x "$STUB_PS"

# Wrapper: runs rgb-lights.sh with PS overridden to our stub.
run_rgb() {
  # Inline-patch: replace the PS assignment then run as a subprocess.
  local patched="$WORK/rgb-lights-patched.sh"
  sed "s|PS=.*|PS=\"$STUB_PS\"|" "$SCRIPT" > "$patched"
  bash "$patched" "$@" 2>&1
  return $?
}

echo "rgb-lights.sh hex guard"

# --- 1. Malicious payload: quote-injection attempt -- must exit 2, no PS call.
rm -f "$PS_MARKER"
out=$(run_rgb on "'; calc #"); rc=$?
if [ "$rc" -eq 2 ]; then
  pass "quote-injection payload exits 2"
else
  fail "quote-injection should exit 2, got rc=$rc: $out"
fi
if [ ! -f "$PS_MARKER" ]; then
  pass "powershell.exe was NOT invoked for quote-injection payload"
else
  fail "powershell.exe was invoked despite rejected payload"
fi

# --- 2. Invalid hex (non-hex chars) -- must exit 2, no PS call.
rm -f "$PS_MARKER"
out=$(run_rgb on "GGGGGG"); rc=$?
if [ "$rc" -eq 2 ]; then
  pass "non-hex 'GGGGGG' exits 2"
else
  fail "non-hex 'GGGGGG' should exit 2, got rc=$rc: $out"
fi
if [ ! -f "$PS_MARKER" ]; then
  pass "powershell.exe was NOT invoked for non-hex payload"
else
  fail "powershell.exe was invoked for non-hex payload"
fi

# --- 3. Too-short hex -- must exit 2.
out=$(run_rgb on "ABCD"); rc=$?
if [ "$rc" -eq 2 ]; then
  pass "4-char hex 'ABCD' exits 2"
else
  fail "4-char hex 'ABCD' should exit 2, got rc=$rc: $out"
fi

# --- 4. Too-long hex -- must exit 2.
out=$(run_rgb on "AABBCCDD"); rc=$?
if [ "$rc" -eq 2 ]; then
  pass "8-char hex 'AABBCCDD' exits 2"
else
  fail "8-char hex 'AABBCCDD' should exit 2, got rc=$rc: $out"
fi

# --- 5. Valid 6-hex uppercase -- must PASS the guard (stub PS invoked).
rm -f "$PS_MARKER"
out=$(run_rgb on "A1B2C3"); rc=$?
if [ "$rc" -eq 0 ]; then
  pass "valid hex 'A1B2C3' exits 0"
else
  fail "valid hex 'A1B2C3' should exit 0, got rc=$rc: $out"
fi
if [ -f "$PS_MARKER" ]; then
  pass "powershell stub WAS invoked for valid hex 'A1B2C3'"
else
  fail "powershell stub was NOT invoked for valid hex 'A1B2C3'"
fi

# --- 6. Valid 6-hex lowercase -- must PASS.
rm -f "$PS_MARKER"
out=$(run_rgb on "a1b2c3"); rc=$?
if [ "$rc" -eq 0 ]; then
  pass "valid lowercase hex 'a1b2c3' exits 0"
else
  fail "valid lowercase hex 'a1b2c3' should exit 0, got rc=$rc: $out"
fi
if [ -f "$PS_MARKER" ]; then
  pass "powershell stub WAS invoked for valid lowercase hex"
else
  fail "powershell stub was NOT invoked for valid lowercase hex"
fi

# --- 7. 'off' action uses hardcoded 000000 -- must PASS the guard.
rm -f "$PS_MARKER"
out=$(run_rgb off); rc=$?
if [ "$rc" -eq 0 ]; then
  pass "'off' action passes guard (hardcoded 000000)"
else
  fail "'off' action should exit 0, got rc=$rc: $out"
fi
if [ -f "$PS_MARKER" ]; then
  pass "powershell stub WAS invoked for 'off' action"
else
  fail "powershell stub was NOT invoked for 'off' action"
fi

# --- 8. Default 'on' (no color arg, defaults to FF0000) -- must PASS.
rm -f "$PS_MARKER"
out=$(run_rgb on); rc=$?
if [ "$rc" -eq 0 ]; then
  pass "'on' with no color arg (FF0000 default) passes guard"
else
  fail "'on' with no color arg should exit 0, got rc=$rc: $out"
fi

echo
if [ "$FAIL" -gt 0 ]; then echo "FAILED ($FAIL)"; exit 1; fi
echo "OK"
