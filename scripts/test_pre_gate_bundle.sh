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
# Schema validation is mandatory -- silent ImportError skip was a false-PASS
# (card c44ea607). If jsonschema is absent, fail loudly so the CI host is
# fixed rather than letting the validation silently not run.
try:
    import jsonschema
except ImportError:
    errs.append("jsonschema not installed -- schema validation cannot run (install it)")
else:
    try:
        with open(os.environ["SCHEMA"], encoding="utf-8") as fh:
            jsonschema.validate(doc, json.load(fh))
    except Exception as exc:
        errs.append("schema validation: %s" % exc)
sys.exit("; ".join(errs) if errs else 0)
PY
if [ $? -eq 0 ]; then ok "pgb_json emits schema-valid JSON (required fields + check shape)"; else bad "pgb_json JSON contract"; fi

# 5b) pgb_json WITH the advisory blocks populated (card ENG-066 / eb02442b).
#
# Test 5 above leaves CROSS_MODEL_JSON / SKILL_CHECK_JSON / DA_SENTINEL_JSON empty, so the
# advisory keys never reach the validated document -- the fixture never enters the state
# where the defect lives. A real `--json` run DOES emit da_sentinel (check_da_sentinel is
# unconditional) and skill_check (with --skill-check), and the schema declares neither
# while setting additionalProperties:false. Result: live --json output is schema-invalid.
#
# This case populates the advisory vars exactly as the checks do, so the schema assertion
# actually exercises them. It MUST fail before the schema is extended.
CHECK_NAMES=(typecheck tests diff-size static)
CHECK_STATUSES=(PASS PASS PASS PASS)
CHECK_DETAILS=("tsc clean" "vitest green" "10 additions" "no secrets")
# Byte-identical to the strings the checks assign (pre-gate-bundle.sh check_da_sentinel /
# check_skill_regression). If those shapes change, this fixture must change with them.
DA_SENTINEL_JSON='{"status":"warn","detail":"DA T1 not triggered"}'
SKILL_CHECK_JSON='{"status":"pass","detail":"SKILL-REGRESSION: 0 regressions"}'
CROSS_MODEL_JSON=''
JSON_ADV="$(pgb_json PASS 10)"
SCHEMA="$SCHEMA" python3 - "$JSON_ADV" <<'PY'
import json, os, sys
doc = json.loads(sys.argv[1])
errs = []
# The advisory blocks must actually be present -- otherwise this test would pass
# vacuously and re-create the very fixture gap it exists to close.
for key in ("da_sentinel", "skill_check"):
    if key not in doc:
        errs.append("fixture did not emit %s (test would be vacuous)" % key)
    elif doc[key].get("status") is None:
        errs.append("%s has no status" % key)
try:
    import jsonschema
    with open(os.environ["SCHEMA"], encoding="utf-8") as fh:
        jsonschema.validate(doc, json.load(fh))
except ImportError:
    errs.append("jsonschema not installed; schema contract unverified")
except Exception as exc:
    errs.append("schema validation: %s" % exc)
sys.exit("; ".join(errs) if errs else 0)
PY
if [ $? -eq 0 ]; then ok "pgb_json with advisory blocks is schema-valid (da_sentinel + skill_check)"; else bad "pgb_json advisory-block JSON contract"; fi

# 5c) cross_model is emitted as an OBJECT, and every status variant must validate.
#
# The schema previously typed cross_model as string|null while check_cross_model has
# always assigned an object ({"status":..,"model":..,"flags":[]}), so --cross-model runs
# were schema-invalid too. The payload set below is taken from the literals in
# check_cross_model -- note status=partial carries an extra low_findings key.
CM_CASES=(
  '{"status":"agreement","model":"claude-x","flags":[]}'
  '{"status":"partial","model":"claude-x","flags":[],"low_findings":["f1","f2"]}'
  '{"status":"contradictory","model":"claude-x","flags":["sev-medium finding"]}'
  '{"status":"skipped","model":null,"flags":[]}'
  '{"status":"unavailable","model":null,"flags":[]}'
  '{"status":"prompt_leak","model":null,"flags":["prompt-leak-detected"]}'
)
DA_SENTINEL_JSON=""; SKILL_CHECK_JSON=""
CM_FAILED=""
for cm_case in "${CM_CASES[@]}"; do
  CROSS_MODEL_JSON="$cm_case"
  CM_JSON="$(pgb_json PASS 0)"
  SCHEMA="$SCHEMA" python3 - "$CM_JSON" <<'PY' || CM_FAILED="yes"
import json, os, sys
doc = json.loads(sys.argv[1])
if "cross_model" not in doc:
    sys.exit("fixture did not emit cross_model (test would be vacuous)")
try:
    import jsonschema
    with open(os.environ["SCHEMA"], encoding="utf-8") as fh:
        jsonschema.validate(doc, json.load(fh))
except ImportError:
    sys.exit("jsonschema not installed; schema contract unverified")
except Exception as exc:
    sys.exit("schema validation: %s -- payload %s" % (exc.message if hasattr(exc, "message") else exc, doc["cross_model"]))
PY
done
if [ -z "$CM_FAILED" ]; then ok "pgb_json cross_model object validates for all ${#CM_CASES[@]} status variants"; else bad "pgb_json cross_model schema contract"; fi
CROSS_MODEL_JSON=""
DA_SENTINEL_JSON=""; SKILL_CHECK_JSON=""   # restore for the cases below

# --------------------------------------------------------------------------- #
# loki-mode gate steal (card d25ebf19): mock-integrity + test-mutation scans.   #
# Both are pure, stdin-fed static-diff heuristics (like pgb_count_additions) so #
# they unit-test without touching git/npx/network. WARN-level by design         #
# (false-positive tolerant) -- they never BLOCK, only flag for reviewer intent. #
# --------------------------------------------------------------------------- #

# 6) mock-integrity: a test that mocks its OWN unit is tautological -> flagged.
MI_SELF="$(printf '%s\n' \
  '+++ b/src/foo.test.ts' \
  '@@ -1,2 +1,3 @@' \
  "+vi.mock('./foo')" \
  "+import { foo } from './foo'" | pgb_scan_mock_integrity)"
case "$MI_SELF" in
  *"src/foo.test.ts:self-mock"*) ok "mock-integrity flags a self-mocked unit" ;;
  *) bad "mock-integrity flags a self-mocked unit (got '$MI_SELF')" ;;
esac

# 6b) mocking a DEPENDENCY (not the unit under test) is legitimate -> no flag.
MI_DEP="$(printf '%s\n' \
  '+++ b/src/foo.test.ts' \
  "+vi.mock('./bar')" | pgb_scan_mock_integrity)"
eq "$MI_DEP" "" "mock-integrity ignores dependency mocks"

# 6c) jest.mock self-mock (double-quoted, parent-relative) is flagged too.
MI_JEST="$(printf '%s\n' \
  '+++ b/pkg/user.spec.ts' \
  '+jest.mock("../user")' | pgb_scan_mock_integrity)"
case "$MI_JEST" in
  *"pkg/user.spec.ts:self-mock"*) ok "mock-integrity flags a jest self-mock" ;;
  *) bad "mock-integrity flags a jest self-mock (got '$MI_JEST')" ;;
esac

# 7) test-mutation: a REMOVED assertion in a test file is flagged.
TM_RM="$(printf '%s\n' \
  '+++ b/src/foo.test.ts' \
  '@@ -1,3 +1,2 @@' \
  '-  expect(result).toBe(42)' \
  '   doThing()' | pgb_scan_test_mutation)"
case "$TM_RM" in
  *"src/foo.test.ts:removed-assertion"*) ok "test-mutation flags a removed assertion" ;;
  *) bad "test-mutation flags a removed assertion (got '$TM_RM')" ;;
esac

# 7b) an ADDED .skip/.only in a test file is flagged.
TM_SKIP="$(printf '%s\n' \
  '+++ b/src/foo.test.ts' \
  "+  it.skip('does thing', () => {" | pgb_scan_test_mutation)"
case "$TM_SKIP" in
  *"src/foo.test.ts:added-skip-or-focus"*) ok "test-mutation flags an added skip/focus" ;;
  *) bad "test-mutation flags an added skip/focus (got '$TM_SKIP')" ;;
esac

# 7c) an assertion change in a NON-test file is NOT a test-mutation signal.
TM_NON="$(printf '%s\n' \
  '+++ b/src/foo.ts' \
  '-  expect(x).toBe(1)' | pgb_scan_test_mutation)"
eq "$TM_NON" "" "test-mutation ignores non-test files"

# 7d) a clean test edit (ADDS a real assertion) is not flagged.
TM_CLEAN="$(printf '%s\n' \
  '+++ b/src/foo.test.ts' \
  '+  expect(result).toBe(7)' | pgb_scan_test_mutation)"
eq "$TM_CLEAN" "" "test-mutation ignores added assertions"

# 7e) a python unittest skip (test_*.py) is flagged (cross-language coverage).
TM_PY="$(printf '%s\n' \
  '+++ b/scripts/test_thing.py' \
  '+    @unittest.skip("flaky")' | pgb_scan_test_mutation)"
case "$TM_PY" in
  *"scripts/test_thing.py:added-skip-or-focus"*) ok "test-mutation flags a python unittest skip" ;;
  *) bad "test-mutation flags a python unittest skip (got '$TM_PY')" ;;
esac

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
