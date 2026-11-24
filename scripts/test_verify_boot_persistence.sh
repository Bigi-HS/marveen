#!/bin/bash
# Test harness for verify-boot-persistence.sh -- the WSL boot-persistence
# go/no-go gate the Thu-Sun migration trusts (GAP G4, card 53b5900d).
#
# Two documented fail-open / abort defects are locked here:
#
#  Fix 1 -- the /etc/wsl.conf [boot] match (script line 45). The original
#    `grep -q "fleet-boot.sh" "$WSL_CONF"` matched the substring ANYWHERE in the
#    file, so a COMMENTED-OUT line (`#command = ... fleet-boot.sh`) or the path
#    appearing in a NON-command context (a comment, a different key) fails OPEN
#    to PASS -- the most dangerous direction for a boot-persistence gate. The
#    tightened match must be anchored to an actual, uncommented `command =` line:
#      grep -Eq '^[[:space:]]*command[[:space:]]*=.*fleet-boot\.sh'
#    Fixtures:
#      (a) a real `command = ... fleet-boot.sh` line          -> PASS
#      (b) a commented `#command = ... fleet-boot.sh` line     -> FAIL/MISS
#      (c) fleet-boot.sh only in a non-command context         -> FAIL/MISS
#
#  Fix 2 -- $USER unbound under `set -u`. The script sets `set -u` and the
#    remediation heredoc references $USER; on an env with USER unset (cron, su,
#    a minimal migration-target shell) the script ABORTS instead of printing the
#    remediation. `env -u USER` must not abort the run.
#
# The script hardcodes WSL_CONF=/etc/wsl.conf; to stay hermetic the test uses
# the WSL_CONF env override the script honors.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/verify-boot-persistence.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── Fixtures: wsl.conf samples ───────────────────────────────────────────────
# (a) valid, uncommented [boot] command -> must PASS the wsl.conf link.
cat > "$TMP/valid.conf" <<'CONF'
[boot]
command = su - dominik -c '/home/dominik/marveen/scripts/fleet-boot.sh'
CONF

# (b) the command is COMMENTED OUT -> must NOT pass (fail-open regression).
cat > "$TMP/commented.conf" <<'CONF'
[boot]
#command = su - dominik -c '/home/dominik/marveen/scripts/fleet-boot.sh'
CONF

# (c) fleet-boot.sh present ONLY in a non-command context (a comment / unrelated
#     key) -> must NOT pass.
cat > "$TMP/noncommand.conf" <<'CONF'
# NOTE: boot used to run fleet-boot.sh here but was moved to a service.
[boot]
systemd = true
CONF

# A conf with NO fleet-boot reference at all -> must NOT pass (control).
cat > "$TMP/absent.conf" <<'CONF'
[boot]
systemd = true
CONF

# run <wsl_conf_path> [extra env ...] -> captures output in $OUT, rc in $RC.
# We only care about the wsl.conf-link line of output, which is deterministic
# regardless of whether the real scripts exist (they do, under ROOT).
run() {
  local conf="$1"; shift
  OUT="$(WSL_CONF="$conf" "$@" bash "$SCRIPT" 2>&1)"; RC=$?
}

# Assert the wsl.conf-link check PASSED (the OK line is present, MISS absent).
assert_link_ok() { # <desc>
  if printf '%s\n' "$OUT" | grep -q 'OK   /etc/wsl.conf \[boot\] command points at fleet-boot.sh'; then
    ok "$1"
  else
    bad "$1 (expected wsl.conf-link OK, got: $(printf '%s' "$OUT" | grep -i wsl.conf | head -1))"
  fi
}
# Assert the wsl.conf-link check did NOT pass (the MISS line is present).
assert_link_bad() { # <desc>
  if printf '%s\n' "$OUT" | grep -q 'MISS /etc/wsl.conf exists but \[boot\] does NOT reference fleet-boot.sh'; then
    ok "$1"
  else
    bad "$1 (expected wsl.conf-link MISS/fail-open regression, got: $(printf '%s' "$OUT" | grep -i wsl.conf | head -1))"
  fi
}

# ── Fix 1: anchored, comment-rejecting [boot] match ──────────────────────────
run "$TMP/valid.conf"
assert_link_ok  "(a) valid uncommented 'command = ...fleet-boot.sh' -> PASS"

run "$TMP/commented.conf"
assert_link_bad "(b) commented '#command = ...fleet-boot.sh' -> MISS (no fail-open)"

run "$TMP/noncommand.conf"
assert_link_bad "(c) fleet-boot.sh only in non-command context -> MISS (no fail-open)"

run "$TMP/absent.conf"
assert_link_bad "(control) no fleet-boot.sh reference -> MISS"

# ── Fix 2: $USER unbound under set -u must not abort ─────────────────────────
# Drive the remediation heredoc by using a wsl.conf that FAILS the link (so
# FAIL=1 and the script reaches the `cat <<EOF ... $USER ... EOF` block), with
# USER scrubbed from the environment. Under the bug this aborts (rc 127-ish /
# "USER: unbound variable"); fixed, it prints remediation and exits 1.
OUT="$(WSL_CONF="$TMP/absent.conf" env -u USER bash "$SCRIPT" 2>&1)"; RC=$?
if printf '%s\n' "$OUT" | grep -q 'unbound variable'; then
  bad "(d) 'env -u USER' run must not abort on unbound \$USER (got unbound-variable abort)"
elif [ "$RC" -eq 1 ] && printf '%s\n' "$OUT" | grep -q 'RESULT: boot-persistence chain INCOMPLETE'; then
  ok "(d) 'env -u USER' run completes and prints remediation (rc=1, no abort)"
else
  bad "(d) 'env -u USER' run unexpected (rc=$RC); output tail: $(printf '%s' "$OUT" | tail -1)"
fi

echo
echo "verify-boot-persistence tests: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
