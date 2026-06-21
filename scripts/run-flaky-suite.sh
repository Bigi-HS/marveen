#!/usr/bin/env bash
# Flaky-test detector: runs the test suite N times and aggregates pass/fail counts.
#
# Usage:
#   ./run-flaky-suite.sh [OPTIONS]
#
# Options:
#   -n NUM         Number of runs (default: 10)
#   -t PATTERN     Test name pattern passed to vitest --reporter=json (default: all)
#   -o FILE        JSON output file (default: flaky-report.json)
#   -d DIR         Project root directory (default: auto-detect from script location)
#   --early-exit   Stop after first confirmed flaky test (3+ runs done, any failure)
#   --quiet        Suppress per-run progress output
#
# Output JSON format:
#   {
#     "runs": 10,
#     "completed": 10,
#     "suite_passed": 8,
#     "suite_failed": 2,
#     "tests": {
#       "db.test.ts > sessions > munkamenetet ment": {
#         "passed": 10, "failed": 0, "flaky": false
#       },
#       "channel-monitor.spec.ts > reconnect": {
#         "passed": 7, "failed": 3, "flaky": true, "fail_rate": "3/10"
#       }
#     },
#     "flaky_tests": ["channel-monitor.spec.ts > reconnect"],
#     "duration_s": 44.2
#   }
#
# A test is considered FLAKY if it fails on at least 1 run but passes on at least 1 run.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
RUNS=10
PATTERN=""
OUT_FILE="flaky-report.json"
EARLY_EXIT=0
QUIET=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Script lives at repo-root/scripts/ -> one level up is the repo root
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        -n)     RUNS="$2"; shift 2 ;;
        -t)     PATTERN="$2"; shift 2 ;;
        -o)     OUT_FILE="$2"; shift 2 ;;
        -d)     PROJECT_DIR="$2"; shift 2 ;;
        --early-exit) EARLY_EXIT=1; shift ;;
        --quiet)      QUIET=1; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
    echo "ERROR: package.json not found in $PROJECT_DIR -- use -d to specify project root" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Temp dir for run outputs
# ---------------------------------------------------------------------------
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SUITE_PASS=0
SUITE_FAIL=0
COMPLETED=0
START_TS="$(date +%s)"

# ---------------------------------------------------------------------------
# Run loop
# ---------------------------------------------------------------------------
for i in $(seq 1 "$RUNS"); do
    RUN_OUT="$TMP_DIR/run-${i}.json"

    [[ $QUIET -eq 0 ]] && echo "[run $i/$RUNS] ..."

    VITEST_ARGS=(run --reporter=json "--outputFile=$RUN_OUT")
    [[ -n "$PATTERN" ]] && VITEST_ARGS+=(-t "$PATTERN")

    # Run vitest; capture exit code without aborting the script
    if (cd "$PROJECT_DIR" && npx vitest "${VITEST_ARGS[@]}" >/dev/null 2>&1); then
        SUITE_PASS=$((SUITE_PASS + 1))
        [[ $QUIET -eq 0 ]] && echo "  -> PASS"
    else
        SUITE_FAIL=$((SUITE_FAIL + 1))
        [[ $QUIET -eq 0 ]] && echo "  -> FAIL"
    fi

    COMPLETED=$((COMPLETED + 1))

    # Early exit check: after at least 3 runs, if we have a flaky candidate
    if [[ $EARLY_EXIT -eq 1 && $COMPLETED -ge 3 && $SUITE_FAIL -ge 1 && $SUITE_PASS -ge 1 ]]; then
        [[ $QUIET -eq 0 ]] && echo "[early-exit] flaky confirmed after $COMPLETED runs"
        break
    fi
done

END_TS="$(date +%s)"
DURATION=$((END_TS - START_TS))

# ---------------------------------------------------------------------------
# Aggregate per-test pass/fail counts from JSON reporter outputs
# ---------------------------------------------------------------------------
python3 - "$TMP_DIR" "$OUT_FILE" "$RUNS" "$COMPLETED" "$SUITE_PASS" "$SUITE_FAIL" "$DURATION" "$PROJECT_DIR" << 'PY'
import json
import os
import sys

tmp_dir, out_file, runs, completed, suite_pass, suite_fail, duration, project_dir = sys.argv[1:]
runs, completed, suite_pass, suite_fail, duration = (
    int(runs), int(completed), int(suite_pass), int(suite_fail), float(duration)
)

tests = {}  # name -> {"passed": int, "failed": int, "errors": []}

for fname in sorted(os.listdir(tmp_dir)):
    if not fname.startswith("run-") or not fname.endswith(".json"):
        continue
    fpath = os.path.join(tmp_dir, fname)
    try:
        with open(fpath) as f:
            data = json.load(f)
    except Exception:
        continue

    # vitest JSON reporter format: testResults[].assertionResults[]
    for suite in data.get("testResults", []):
        raw_path = suite.get("name") or suite.get("testFilePath") or ""
        suite_name = os.path.relpath(raw_path, project_dir) if raw_path else "<unknown>"
        for t in suite.get("assertionResults", []):
            # Build a unique key: file > describe > test
            ancestors = " > ".join(t.get("ancestorTitles", []))
            title = t.get("title", "")
            key = f"{suite_name} > {ancestors} > {title}" if ancestors else f"{suite_name} > {title}"
            key = key.strip(" >")

            if key not in tests:
                tests[key] = {"passed": 0, "failed": 0, "errors": []}

            status = t.get("status", "")
            if status == "passed":
                tests[key]["passed"] += 1
            else:
                tests[key]["failed"] += 1
                if t.get("failureMessages"):
                    tests[key]["errors"].append(t["failureMessages"][0][:200])

# Classify flaky
flaky_tests = []
for name, counts in tests.items():
    counts["flaky"] = counts["failed"] > 0 and counts["passed"] > 0
    if counts["flaky"]:
        counts["fail_rate"] = f"{counts['failed']}/{counts['passed'] + counts['failed']}"
        flaky_tests.append(name)
    elif counts["failed"] > 0:
        counts["fail_rate"] = f"{counts['failed']}/{counts['passed'] + counts['failed']}"
    # Remove empty errors list to keep output clean
    if not counts["errors"]:
        del counts["errors"]

report = {
    "runs": runs,
    "completed": completed,
    "suite_passed": suite_pass,
    "suite_failed": suite_fail,
    "tests": tests,
    "flaky_tests": sorted(flaky_tests),
    "duration_s": duration,
}

with open(out_file, "w") as f:
    json.dump(report, f, indent=2)

print(f"Flaky report written to {out_file}")
print(f"  Runs: {completed}/{runs} | Suite PASS: {suite_pass} | FAIL: {suite_fail}")
if flaky_tests:
    print(f"  FLAKY ({len(flaky_tests)}):")
    for t in flaky_tests:
        rate = tests[t].get("fail_rate", "?")
        print(f"    [{rate} failed] {t}")
else:
    print("  No flaky tests detected.")
PY
