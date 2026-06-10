#!/usr/bin/env bash
# Unit tests for scripts/pre-gate-bundle.sh (Thor card b45884fb).
#
# The bundle's decision logic is factored into pure functions (pgb_verdict,
# pgb_count_additions, pgb_exit_code, pgb_json) that take their input as args/stdin and
# touch no git/npx/network. We SOURCE the script (its main() is guarded by a
# BASH_SOURCE==$0 check) and exercise those functions in isolation. No secret value is
# ever printed; the JSON test asserts the contract, not real diff content.
#
# Run: bash scripts/test_pre_gate_bundle.sh
set -uo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/pre-gate-bundle.sh"
SCHEMA="$(cd "$(dirname "$0")" && pwd)/pre-gate-schema.json"
# shellcheck source=/dev/null
. "$SCRIPT"

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

eq() {  # got expected desc
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1', expected '$2')"; fi
}

# 1) verdict: all PASS -> PASS
eq "$(pgb_verdict PASS PASS PASS PASS)" "PASS" "all PASS -> PASS"

# 2) verdict: a WARN with the rest PASS -> WARN
eq "$(pgb_verdict PASS WARN PASS)" "WARN" "any WARN (no BLOCK) -> WARN"

# 3) verdict: a BLOCK dominates even alongside WARN
eq "$(pgb_verdict PASS WARN BLOCK)" "BLOCK" "any BLOCK -> BLOCK"
eq "$(pgb_exit_code "$(pgb_verdict PASS WARN BLOCK)")" "1" "BLOCK -> exit 1"
eq "$(pgb_exit_code "$(pgb_verdict PASS WARN PASS)")" "0" "WARN -> exit 0"

# 4) count_additions: sums the numstat additions column; binary '-' counts as 0
ADDED="$(printf '%s\n' \
  $'10\t2\tsrc/a.ts' \
  $'5\t0\tsrc/b.ts' \
  $'-\t-\tassets/logo.png' | pgb_count_additions)"
eq "$ADDED" "15" "count_additions sums numstat, binary '-' -> 0"
eq "$(printf '' | pgb_count_additions)" "0" "count_additions empty diff -> 0"

# 5) pgb_json: emits schema-valid JSON with the required fields + per-check shape
CHECK_NAMES=(typecheck tests diff-size static)
CHECK_STATUSES=(PASS PASS WARN PASS)
CHECK_DETAILS=("tsc clean" "vitest green" "512 additions (> 400)" "no secrets")
JSON="$(pgb_json WARN 512)"
SCHEMA="$SCHEMA" python3 - "$JSON" <<'PY'
import json, os, sys
doc = json.loads(sys.argv[1])
errs = []
# Required top-level fields + enum.
if doc.get("verdict") not in ("PASS", "WARN", "BLOCK"):
    errs.append("verdict missing/invalid")
if not isinstance(doc.get("diff_additions"), int):
    errs.append("diff_additions not int")
checks = doc.get("checks")
if not isinstance(checks, list) or not checks:
    errs.append("checks missing/empty")
else:
    for c in checks:
        if set(c) != {"name", "status", "detail"}:
            errs.append("check keys != name/status/detail: %r" % sorted(c))
        if c.get("status") not in ("PASS", "WARN", "BLOCK"):
            errs.append("check status invalid: %r" % c.get("status"))
if doc.get("verdict") != "WARN" or doc.get("diff_additions") != 512 or len(checks) != 4:
    errs.append("values not round-tripped")
# If jsonschema is available, validate against the real schema file too.
try:
    import jsonschema
    with open(os.environ["SCHEMA"], encoding="utf-8") as fh:
        jsonschema.validate(doc, json.load(fh))
except ImportError:
    pass
except Exception as exc:  # schema validation failure is a real error
    errs.append("schema validation: %s" % exc)
sys.exit("; ".join(errs) if errs else 0)
PY
if [ $? -eq 0 ]; then ok "pgb_json emits schema-valid JSON (required fields + check shape)"; else bad "pgb_json JSON contract"; fi

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
