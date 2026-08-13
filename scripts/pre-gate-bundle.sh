#!/usr/bin/env bash
# pre-gate-bundle.sh -- mechanical pre-gate evidence bundle (Thor card b45884fb).
#
# Runs a set of DETERMINISTIC checks against a PR (base-branch ... head-sha) and emits a
# single verdict (PASS / WARN / BLOCK) plus per-check evidence. The point is to hand
# the merge gate (Thor + Dave [+ Chad]) a uniform, reproducible evidence sheet instead
# of ad-hoc "I ran the tests" claims.
#
# Checks:
#   typecheck      `npx tsc --noEmit`               -- type errors -> BLOCK; tooling missing -> WARN
#   tests          `npx vitest run` (worktrees excl) -- any failure -> BLOCK; runner missing -> WARN
#   diff-size      `git diff --numstat base...head`  -- additions count; over threshold -> WARN
#   static         secret + unused-export grep       -- hardcoded secret -> BLOCK; unused export -> WARN
#   gitleaks       gitleaks diff scan (card ea3720b3) -- secret found -> BLOCK; binary missing -> WARN
#   mock-integrity self-mocked-unit scan (card d25ebf19) -- tautological test -> WARN (loki-mode steal)
#   test-mutation  weakened/disabled-test scan (card d25ebf19) -- assertion removed/skipped -> WARN
#
# Usage:
#   scripts/pre-gate-bundle.sh <base-branch> <head-sha> [--json] [--notify[=agent]]
#     --json            emit the bundle as JSON (schema: scripts/pre-gate-schema.json)
#     --notify[=agent]  also post the one-line summary as an inter-agent message
#                       (default recipient: marveen) via the dashboard API
#
# Exit code: PASS / WARN -> 0, BLOCK -> 1 (so `if pre-gate-bundle.sh ...; then` gates).
#
# NOTE on test runner exit codes (Thor dogfood finding): NEVER pipe the test runner into
# another command to capture its status -- the pipe's exit code is the tail command's,
# not the runner's. Always `out=$(runner 2>&1); rc=$?`.
#
# Deliberately NOT `set -e`: every check must run so the bundle is complete; we aggregate
# their statuses into the verdict rather than aborting on the first non-zero.
set -uo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Additions above this count flag the diff-size check as WARN (large PR -> review care).
PGB_DIFF_WARN="${PGB_DIFF_WARN:-600}"

# Worktree test files are collected by vitest if not excluded (Thor dogfood finding):
# a sibling worktree's *.test.ts under .claude/worktrees/** would pollute the run.
VITEST_EXCLUDE='.claude/worktrees/**'

# DA T1 sentinel directory (spec: store/specs/devil-advocate-agent.md, M2). Overridable
# for hermetic tests. The check is "any T1 sentinel present" -- not spec-id specific.
DA_RUNS_DIR="${DA_RUNS_DIR:-$INSTALL_DIR/store/da-runs}"

# --------------------------------------------------------------------------- #
# Pure helpers (sourced + unit-tested without running the checks)              #
# --------------------------------------------------------------------------- #

# Aggregate per-check statuses into the bundle verdict.
# Any BLOCK -> BLOCK; else any WARN -> WARN; else PASS. Echoes the verdict.
pgb_verdict() {
  local s has_warn=0
  for s in "$@"; do
    case "$s" in
      BLOCK) printf 'BLOCK'; return 0 ;;
      WARN)  has_warn=1 ;;
    esac
  done
  if [ "$has_warn" -eq 1 ]; then printf 'WARN'; else printf 'PASS'; fi
}

# Map a verdict to its process exit code.
pgb_exit_code() {
  case "$1" in
    BLOCK) printf '1' ;;
    *)     printf '0' ;;
  esac
}

# Sum the additions column of `git diff --numstat` output (read on stdin).
# Binary files report `-` for additions; those count as 0.
pgb_count_additions() {
  awk '{ if ($1 ~ /^[0-9]+$/) total += $1 } END { print total + 0 }'
}

# Emit the bundle as JSON conforming to scripts/pre-gate-schema.json. Reads the parallel
# CHECK_* arrays from the environment of the caller. Built via python3 (jq is absent on
# this host) so quoting/escaping is correct. Never prints a secret VALUE -- details are
# pattern names and counts only.
pgb_json() {
  local verdict="$1" additions="$2"
  PGB_VERDICT="$verdict" PGB_ADDITIONS="$additions" \
  PGB_NAMES="$(printf '%s\n' "${CHECK_NAMES[@]}")" \
  PGB_STATUSES="$(printf '%s\n' "${CHECK_STATUSES[@]}")" \
  PGB_DETAILS="$(printf '%s\n' "${CHECK_DETAILS[@]}")" \
  PGB_CROSS_MODEL="$CROSS_MODEL_JSON" \
  PGB_SKILL_CHECK="$SKILL_CHECK_JSON" \
  PGB_DA_SENTINEL="$DA_SENTINEL_JSON" \
  PGB_BASE_ANCHOR="$BASE_ANCHOR" \
  python3 - <<'PY'
import json, os
names = os.environ["PGB_NAMES"].splitlines()
statuses = os.environ["PGB_STATUSES"].splitlines()
details = os.environ["PGB_DETAILS"].splitlines()
checks = [
    {"name": n, "status": s, "detail": d}
    for n, s, d in zip(names, statuses, details)
]
out = {
    "verdict": os.environ["PGB_VERDICT"],
    "checks": checks,
    "diff_additions": int(os.environ["PGB_ADDITIONS"]),
    # "fetched" | "stale". "stale" means `git fetch origin` FAILED, so the 3-dot
    # diff ran against a possibly-outdated on-disk origin/<branch>. Consumers must
    # not read a green verdict as "measured against the current remote tip".
    "base_anchor": os.environ.get("PGB_BASE_ANCHOR", "fetched"),
}
cm = os.environ.get("PGB_CROSS_MODEL", "")
if cm:
    try:
        out["cross_model"] = json.loads(cm)
    except Exception:
        pass
sc = os.environ.get("PGB_SKILL_CHECK", "")
if sc:
    try:
        out["skill_check"] = json.loads(sc)
    except Exception:
        pass
ds = os.environ.get("PGB_DA_SENTINEL", "")
if ds:
    try:
        out["da_sentinel"] = json.loads(ds)
    except Exception:
        pass
print(json.dumps(out, indent=2))
PY
}

# --------------------------------------------------------------------------- #
# Check accumulator                                                            #
# --------------------------------------------------------------------------- #
# Base-anchor state: "fetched" (origin refreshed OK) | "stale" (fetch failed, the
# base ref on disk may be outdated). Set in main(); defaults to the optimistic
# value only so that sourcing the script for unit tests keeps a defined variable.
BASE_ANCHOR="fetched"
CHECK_NAMES=()
CHECK_STATUSES=()
CHECK_DETAILS=()

record() {  # name status detail
  CHECK_NAMES+=("$1")
  CHECK_STATUSES+=("$2")
  CHECK_DETAILS+=("$3")
}

# Cross-model advisory (populated by check_cross_model; never changes verdict/exit code)
CROSS_MODEL_LINES=()   # printed after main checks in text mode
CROSS_MODEL_JSON=""    # injected into pgb_json output when non-empty

# Skill-check advisory (populated by check_skill_regression; never changes verdict/exit code)
SKILL_CHECK_LINES=()   # printed after main checks in text mode
SKILL_CHECK_JSON=""    # injected into pgb_json output when non-empty

# DA-trigger advisory (populated by check_da_sentinel; never changes verdict/exit code)
DA_SENTINEL_LINES=()   # printed after main checks in text mode
DA_SENTINEL_JSON=""    # injected into pgb_json output when non-empty

# --------------------------------------------------------------------------- #
# The four checks                                                              #
# --------------------------------------------------------------------------- #

check_typecheck() {
  if ! command -v npx >/dev/null 2>&1; then
    record typecheck WARN "npx not found; tsc skipped (verify the toolchain on the runner)"
    return
  fi
  local out rc
  out="$(npx tsc --noEmit 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ]; then
    record typecheck PASS "tsc --noEmit clean"
  else
    local n
    n="$(printf '%s\n' "$out" | grep -cE 'error TS[0-9]+' || true)"
    record typecheck BLOCK "tsc --noEmit failed: ${n} type error(s)"
  fi
}

check_tests() {
  if ! command -v npx >/dev/null 2>&1; then
    record tests WARN "npx not found; vitest skipped (verify the toolchain on the runner)"
    return
  fi
  local out rc summary
  # Capture rc directly off the runner -- do NOT pipe it (see header note).
  out="$(npx vitest run --exclude "$VITEST_EXCLUDE" 2>&1)"; rc=$?
  # Pull vitest's own "Tests N passed | M failed" line for the detail, if present.
  summary="$(printf '%s\n' "$out" | grep -E 'Tests[[:space:]]+[0-9]' | tail -1 | sed 's/^[[:space:]]*//')"
  [ -n "$summary" ] || summary="see runner output"
  if [ "$rc" -eq 0 ]; then
    record tests PASS "vitest run green (${summary})"
  else
    record tests BLOCK "vitest run failed (${summary})"
  fi
}

check_diff_size() {
  local additions
  additions="$(git -C "$INSTALL_DIR" diff --numstat "${BASE}...${HEAD}" 2>/dev/null | pgb_count_additions)"
  DIFF_ADDITIONS="$additions"
  if [ "$additions" -gt "$PGB_DIFF_WARN" ]; then
    record diff-size WARN "${additions} additions (> ${PGB_DIFF_WARN}; large PR, review carefully)"
  else
    record diff-size PASS "${additions} additions"
  fi
}

# Static grep over the ADDED lines only. Reports pattern names + counts, never the
# matched secret value (no-secret-echo rule).
check_static() {
  local added secret_hits=0 unused=()
  added="$(git -C "$INSTALL_DIR" diff --unified=0 "${BASE}...${HEAD}" -- . ":(exclude)${VITEST_EXCLUDE}" 2>/dev/null \
            | grep -E '^\+' | grep -vE '^\+\+\+' || true)"

  # --- hardcoded secrets (BLOCK) ---
  local pat name matched_patterns=()
  # name|regex pairs of high-signal secret shapes.
  for pat in \
    'anthropic-key|sk-ant-[A-Za-z0-9-]{8,}' \
    'aws-access-key|AKIA[0-9A-Z]{16}' \
    'telegram-bot-token|[0-9]{8,10}:[A-Za-z0-9_-]{35}' \
    'private-key-block|-----BEGIN[A-Z ]*PRIVATE KEY-----' \
    'generic-secret-assign|(api[_-]?key|secret|passwd|password)["'"'"' ]*[:=][ ]*["'"'"'][^"'"'"']{12,}' ; do
    name="${pat%%|*}"
    local rx="${pat#*|}"
    local c
    # -e guards patterns that begin with '-' (e.g. the PRIVATE KEY block) so grep
    # does not parse them as options; default to 0 if grep matched nothing.
    c="$(printf '%s\n' "$added" | grep -ciE -e "$rx" || true)"
    c="${c:-0}"
    if [ "$c" -gt 0 ]; then
      secret_hits=$((secret_hits + c))
      matched_patterns+=("${name}(${c})")
    fi
  done

  # --- newly-added exports with zero repo-wide references (WARN, best-effort) ---
  local ident
  while IFS= read -r ident; do
    [ -n "$ident" ] || continue
    local refs
    refs="$(git -C "$INSTALL_DIR" grep -h -wE "$ident" -- '*.ts' '*.tsx' '*.js' \
              ':(exclude).claude/worktrees/**' 2>/dev/null | wc -l | tr -d ' ')"
    # 1 reference == the definition line itself; <=1 means nothing uses it.
    if [ "${refs:-0}" -le 1 ]; then
      unused+=("$ident")
    fi
  done < <(printf '%s\n' "$added" \
            | grep -oE '^\+[[:space:]]*export[[:space:]]+(async[[:space:]]+)?(const|function|class|interface|type|enum)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' \
            | grep -oE '[A-Za-z_][A-Za-z0-9_]*$' | sort -u)

  if [ "$secret_hits" -gt 0 ]; then
    local IFS=,
    record static BLOCK "possible hardcoded secret(s): ${matched_patterns[*]} (value NOT shown)"
  elif [ "${#unused[@]}" -gt 0 ]; then
    local IFS=,
    record static WARN "added export(s) with no repo reference: ${unused[*]}"
  else
    record static PASS "no hardcoded secrets, no orphan exports"
  fi
}

# Gitleaks secret scan over the diff (card ea3720b3). Augments check_static with
# entropy-based detection and 100+ upstream rules that regex-grep cannot cover
# (e.g. base64-encoded secrets, high-entropy strings, cloud-provider key formats).
# Fail-open: if the gitleaks binary is absent, records WARN (same pattern as
# other optional tooling). Never prints a secret value -- only rule-id + file.
#
# The binary lives in scripts/bin/gitleaks (gitignored; install with
# scripts/install-gitleaks.sh). A custom scripts/gitleaks.toml suppresses
# known fleet-safe patterns (dashboard-token read idiom, test fixtures).
check_gitleaks() {
  local gl_bin="${GITLEAKS_BIN:-${INSTALL_DIR}/scripts/bin/gitleaks}"
  if [ ! -x "$gl_bin" ]; then
    record gitleaks WARN "gitleaks binary not found at ${gl_bin}; run scripts/install-gitleaks.sh"
    return
  fi

  local config_arg=()
  local toml="${INSTALL_DIR}/scripts/gitleaks.toml"
  [ -f "$toml" ] && config_arg=(--config "$toml")

  # Write diff to a temp file; gitleaks' stdin mode reads unified diffs.
  local tmpfile
  tmpfile="$(mktemp /tmp/pgb-gitleaks-diff.XXXXXX)"

  git -C "$INSTALL_DIR" diff "${BASE}...${HEAD}" -- . \
      ":(exclude)${VITEST_EXCLUDE}" >"$tmpfile" 2>/dev/null || true

  if [ ! -s "$tmpfile" ]; then
    rm -f "$tmpfile"
    record gitleaks PASS "empty diff; nothing to scan"
    return
  fi

  # --no-banner: suppress the gitleaks ascii art in CI output.
  # --exit-code 1: gitleaks exits 1 on findings, 0 on clean.
  # Report format: json to stdout (we extract only rule-id + file, never the value).
  # NOTE: capture stdout and exit code separately; do NOT use `|| true` here --
  # that would swallow the exit code and always make gl_rc=0 (false clean).
  local gl_out gl_rc
  gl_out="$("$gl_bin" detect \
      "${config_arg[@]}" \
      --source /dev/stdin \
      --report-format json \
      --report-path /dev/stdout \
      --no-banner \
      --log-level warn \
      --exit-code 1 \
      < "$tmpfile" 2>/dev/null)"
  gl_rc=$?
  rm -f "$tmpfile"

  if [ "$gl_rc" -eq 0 ]; then
    record gitleaks PASS "gitleaks: no secrets detected"
    return
  fi

  # Parse findings from JSON. Print rule-id + file only, never the secret value.
  local findings
  findings="$(printf '%s\n' "$gl_out" | python3 - <<'PY'
import json, sys
try:
    data = json.load(sys.stdin)
    if not data:
        print("(no parseable findings)")
        sys.exit(0)
    seen = {}
    for item in data:
        rid = item.get("RuleID", "?")
        f   = item.get("File", "?")
        seen.setdefault(rid, set()).add(f)
    parts = ["%s(%s)" % (rid, ",".join(sorted(files))) for rid, files in sorted(seen.items())]
    print(", ".join(parts))
except Exception as e:
    print("parse-error: %s" % e)
PY
)" 2>/dev/null || findings="(parse error)"

  record gitleaks BLOCK "gitleaks findings (secret value NOT shown): ${findings}"
}

# --------------------------------------------------------------------------- #
# loki-mode gate steal (card d25ebf19): two static-diff test-quality heuristics #
# borrowed from asklokesh/loki-mode. Both are WARN-only by design (heuristics   #
# with real false-positive rates) -- they surface intent for the reviewer, they #
# never BLOCK. Detection logic lives in pure, stdin-fed scan functions (like    #
# pgb_count_additions) so it unit-tests without git/npx/network. The scanners   #
# self-filter to test files via the diff's `+++ b/` headers; details name files #
# and signal categories only, never the changed line content.                   #
# --------------------------------------------------------------------------- #

# Mock-integrity: flag a test that mocks the very unit it is named after
# (`foo.test.ts` doing `vi.mock('./foo')`) -- the mock replaces the real
# implementation, so the test verifies the mock, not the code (tautology).
# Mocking a DEPENDENCY is legitimate and is NOT flagged. JS/TS scope: vi.mock /
# jest.mock (python patch() self-mock is a distinct pattern, out of scope here).
# Reads a unified diff on stdin; echoes "file:self-mock" entries (comma-joined),
# empty when clean.
pgb_scan_mock_integrity() {
  # Read the diff from stdin into an env var: a `python3 - <<'PY'` heredoc claims
  # stdin for the PROGRAM, so the diff must reach python another way (env, same
  # idiom as check_cross_model). `cat` drains the piped diff.
  local diff; diff="$(cat)"
  PGB_DIFF="$diff" python3 - <<'PY'
import re, os
cur = None
unit = None
is_test = False
seen = set()
flags = []
test_re = re.compile(r'\.(test|spec)\.[A-Za-z0-9]+$')
mock_re = re.compile(r'(?:vi|jest)\.mock\s*\(\s*[\'"]([^\'"]+)[\'"]')
for raw in os.environ.get("PGB_DIFF", "").splitlines():
    line = raw
    if line.startswith('+++ '):
        path = line[4:].strip()
        if path.startswith('b/'):
            path = path[2:]
        cur = path
        base = path.rsplit('/', 1)[-1]
        is_test = bool(test_re.search(base))
        unit = test_re.sub('', base) if is_test else None
        continue
    if not is_test or not line.startswith('+') or line.startswith('+++'):
        continue
    m = mock_re.search(line)
    if not m:
        continue
    target = m.group(1).rsplit('/', 1)[-1]
    target = re.sub(r'\.[A-Za-z0-9]+$', '', target)
    if unit and target == unit:
        key = '%s:self-mock' % cur
        if key not in seen:
            seen.add(key)
            flags.append(key)
print(', '.join(flags))
PY
}

# Test-mutation: flag PRs that WEAKEN tests to pass rather than fixing code --
# removed assertions (`- expect(...)`, `- assert ...`) or newly added
# skips/focus (`.skip(`, `.only(`, `xit(`, `*.todo`, `@unittest.skip`, ...).
# Only test files are considered (JS/TS *.test.*/*.spec.*, python *.test.py or
# test_*.py). Reads a unified diff on stdin; echoes "file:signal" entries
# (comma-joined), empty when clean.
pgb_scan_test_mutation() {
  # See pgb_scan_mock_integrity: pass the piped diff via env, not the heredoc-stdin.
  local diff; diff="$(cat)"
  PGB_DIFF="$diff" python3 - <<'PY'
import re, os
cur = None
is_test = False
sigs = {}
def is_test_file(base):
    return bool(re.search(r'\.(test|spec)\.[A-Za-z0-9]+$', base)) or \
           bool(re.match(r'test_.*\.py$', base))
removed_assert = re.compile(r'(?:\bexpect\s*\(|\bassert\b|\bself\.assert)')
added_disable = re.compile(
    r'(?:\.skip\s*\(|\.only\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\bfit\s*\('
    r'|(?:it|test|describe)\.todo\b|@unittest\.skip|pytest\.mark\.skip'
    r'|\bself\.skipTest\s*\()')
for raw in os.environ.get("PGB_DIFF", "").splitlines():
    line = raw
    if line.startswith('+++ '):
        path = line[4:].strip()
        if path.startswith('b/'):
            path = path[2:]
        cur = path
        base = path.rsplit('/', 1)[-1]
        is_test = is_test_file(base)
        continue
    if not is_test:
        continue
    if line.startswith('-') and not line.startswith('---'):
        if removed_assert.search(line):
            sigs.setdefault(cur, set()).add('removed-assertion')
    elif line.startswith('+') and not line.startswith('+++'):
        if added_disable.search(line):
            sigs.setdefault(cur, set()).add('added-skip-or-focus')
out = []
for f in sorted(sigs):
    for s in sorted(sigs[f]):
        out.append('%s:%s' % (f, s))
print(', '.join(out))
PY
}

# Wrapper: run the mock-integrity scan over the PR diff and record a check.
check_mock_integrity() {
  local hits
  hits="$(git -C "$INSTALL_DIR" diff "${BASE}...${HEAD}" -- . \
            ":(exclude)${VITEST_EXCLUDE}" 2>/dev/null | pgb_scan_mock_integrity)"
  if [ -n "$hits" ]; then
    record mock-integrity WARN "test(s) mock the unit under test (tautological): ${hits}"
  else
    record mock-integrity PASS "no self-mocked units in changed tests"
  fi
}

# Wrapper: run the test-mutation scan over the PR diff and record a check.
check_test_mutation() {
  local hits
  hits="$(git -C "$INSTALL_DIR" diff "${BASE}...${HEAD}" -- . \
            ":(exclude)${VITEST_EXCLUDE}" 2>/dev/null | pgb_scan_test_mutation)"
  if [ -n "$hits" ]; then
    record test-mutation WARN "test assertions weakened/disabled (review intent): ${hits}"
  else
    record test-mutation PASS "no weakened or disabled tests"
  fi
}

# Optional cross-model critic (--cross-model flag). Calls a local Ollama model to
# surface same-model blind spots. Result is ADVISORY ONLY: FLAG lines must be
# addressed by the gate reviewer in their APPROVE comment, but they never change
# the PASS/WARN/BLOCK verdict or exit code. Fail-open: any API/parse error emits
# a WARN line and continues.
# Policy: store/cross-model-verdict-policy.md (local working doc, gitignored).
#
# Config (gitignored store/cross-model.env) is overridable via env vars for tests:
#   CROSS_MODEL_BASE  -- Ollama base URL  (default http://localhost:11434)
#   CROSS_MODEL_MODEL -- model tag        (default deepseek-r1:7b)
check_cross_model() {
  # Read config: env var > env file > hardcoded default
  local cm_base="${CROSS_MODEL_BASE:-}"
  local cm_model="${CROSS_MODEL_MODEL:-}"
  local env_file="$INSTALL_DIR/store/cross-model.env"
  if [ -f "$env_file" ]; then
    local _v
    [ -z "$cm_base"  ] && { _v="$(grep -E '^CROSS_MODEL_BASE='  "$env_file" 2>/dev/null | head -1 | cut -d= -f2-)"; [ -n "$_v" ] && cm_base="$_v";  }
    [ -z "$cm_model" ] && { _v="$(grep -E '^CROSS_MODEL_MODEL=' "$env_file" 2>/dev/null | head -1 | cut -d= -f2-)"; [ -n "$_v" ] && cm_model="$_v"; }
  fi
  [ -z "$cm_base"  ] && cm_base="http://localhost:11434"
  [ -z "$cm_model" ] && cm_model="deepseek-r1:7b"

  # Health check (fail-open: Ollama might not be running)
  if ! curl -sf --max-time 5 "$cm_base/api/tags" >/dev/null 2>&1; then
    CROSS_MODEL_LINES=("[WARN] cross-model critic unavailable: Ollama not reachable at ${cm_base}; skipping")
    CROSS_MODEL_JSON='{"status":"unavailable","model":null,"flags":[]}'
    return 0
  fi

  # Collect PR context from git (no fleet-internal data -- only diff/title/desc)
  local diff title desc
  diff="$(git -C "$INSTALL_DIR" diff "${BASE}...${HEAD}" -- . \
          ":(exclude)${VITEST_EXCLUDE}" 2>/dev/null | head -c 40000)"
  title="$(git -C "$INSTALL_DIR" log --format='%s' "${BASE}...${HEAD}" 2>/dev/null | head -1)"
  desc="$(git -C "$INSTALL_DIR" log --format='%b' "${BASE}...${HEAD}" 2>/dev/null | head -c 3000)"
  [ -z "$title" ] && title="(no commit message)"

  if [ -z "$diff" ]; then
    CROSS_MODEL_LINES=("[WARN] cross-model: empty diff; skipping")
    CROSS_MODEL_JSON='{"status":"skipped","model":null,"flags":[]}'
    return 0
  fi

  local prompt_tmpl="$INSTALL_DIR/scripts/cross-model-audit-prompt.txt"
  if [ ! -f "$prompt_tmpl" ]; then
    CROSS_MODEL_LINES=("[WARN] cross-model: prompt template missing (scripts/cross-model-audit-prompt.txt); skipping")
    CROSS_MODEL_JSON='{"status":"unavailable","model":null,"flags":[]}'
    return 0
  fi

  # Call Ollama and parse response. Pure Python/urllib -- no external dependencies.
  # The assembled prompt contains ONLY title/description/diff (no fleet config/tokens).
  local cm_out cm_rc
  cm_out="$(CM_BASE="$cm_base" CM_MODEL="$cm_model" \
    CM_TITLE="$title" CM_DESC="$desc" CM_DIFF="$diff" \
    CM_PROMPT="$prompt_tmpl" \
    python3 - <<'PYEOF'
import json, os, re, sys, urllib.request

base  = os.environ["CM_BASE"]
model = os.environ["CM_MODEL"]
diff  = os.environ["CM_DIFF"]
title = os.environ["CM_TITLE"]
desc  = os.environ["CM_DESC"]

# Build prompt from template; substitute only the three documented placeholders
tmpl = open(os.environ["CM_PROMPT"], encoding="utf-8").read()
prompt = tmpl.replace("{{TITLE}}", title).replace("{{DESCRIPTION}}", desc).replace("{{DIFF}}", diff)

# Runtime guard (AC#10): prompt must not leak fleet-internal config (check outside diff only)
FORBIDDEN = ("DASHBOARD_TOKEN", "bearer", "agent_id", "vault", "allowFrom")
prompt_without_diff = prompt.replace(diff, "<<DIFF_REDACTED>>")
leaks = [k for k in FORBIDDEN if k in prompt_without_diff]
if leaks:
    print("PROMPT_LEAK:" + ",".join(leaks), file=sys.stderr); sys.exit(3)

payload = {
    "model": model,
    "messages": [{"role": "user", "content": prompt}],
    "stream": False,
}
req = urllib.request.Request(
    base + "/v1/chat/completions",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read().decode()
except Exception as e:
    print(f"API_ERROR:{e}", file=sys.stderr); sys.exit(1)

try:
    resp = json.loads(body)
    content = resp["choices"][0]["message"]["content"]
except Exception as e:
    print(f"PARSE_ERROR:{e}", file=sys.stderr); sys.exit(1)

# Strip deepseek-r1 thinking chain if present, extract JSON from optional code fences
content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", content, re.DOTALL)
if m:
    content = m.group(1)

try:
    result = json.loads(content)
except Exception as e:
    print(f"JSON_ERROR:{e}\nraw:{content[:300]}", file=sys.stderr); sys.exit(1)

required = {"model", "findings", "overall", "overall_rationale"}
missing = required - result.keys()
if missing:
    print(f"SCHEMA_ERROR:missing {missing}", file=sys.stderr); sys.exit(2)

print(json.dumps(result))
PYEOF
  )"; cm_rc=$?

  if [ "$cm_rc" -eq 3 ]; then
    CROSS_MODEL_LINES=("[FLAG] cross-model: prompt leak detected -- internal config keyword in assembled prompt; gate must address this FLAG before merge")
    CROSS_MODEL_JSON='{"status":"prompt_leak","model":null,"flags":["prompt-leak-detected"]}'
    return 0
  elif [ "$cm_rc" -ne 0 ]; then
    CROSS_MODEL_LINES=("[WARN] cross-model critic unavailable: API/parse error (rc=${cm_rc}); skipping")
    CROSS_MODEL_JSON='{"status":"unavailable","model":null,"flags":[]}'
    return 0
  fi

  # Classify: AGREEMENT / PARTIAL / CONTRADICTORY
  # AGREEMENT  = no findings at all   (empty list)
  # PARTIAL    = findings present but none at medium+
  # CONTRADICTORY = at least one medium/high/critical finding
  local overall cm_model_id medium_plus any_findings
  overall="$(printf '%s' "$cm_out" | python3 -c \
    'import json,sys; print(json.load(sys.stdin).get("overall","pass"))' 2>/dev/null || echo "pass")"
  cm_model_id="$(printf '%s' "$cm_out" | python3 -c \
    'import json,sys; print(json.load(sys.stdin).get("model","unknown"))' 2>/dev/null || echo "unknown")"
  any_findings="$(printf '%s' "$cm_out" | python3 -c \
    'import json,sys; print(len(json.load(sys.stdin).get("findings",[])))' 2>/dev/null || echo 0)"
  medium_plus="$(printf '%s' "$cm_out" | python3 -c '
import json, sys
d = json.load(sys.stdin)
sev = ("critical","high","medium")
for f in d.get("findings", []):
    if f.get("severity") in sev:
        print(f["id"] + " (" + f.get("severity","?") + ") -- " + f.get("summary","")[:100])
' 2>/dev/null || true)"

  local flags=()
  if [ -z "$medium_plus" ] && [ "${any_findings:-0}" -eq 0 ]; then
    CROSS_MODEL_LINES=("[cross-model] AGREEMENT: no additional findings (model: ${cm_model_id})")
    CROSS_MODEL_JSON="$(printf '%s' "$cm_out" | python3 -c \
      'import json,sys; d=json.load(sys.stdin); print(json.dumps({"status":"agreement","model":d.get("model"),"flags":[]}))' 2>/dev/null \
      || echo '{"status":"agreement","model":null,"flags":[]}')"
  elif [ -z "$medium_plus" ]; then
    local low_count="${any_findings:-0}"
    CROSS_MODEL_LINES=("[cross-model] PARTIAL: ${low_count} low/info finding(s) noted (no FLAG required; see detail)")
    CROSS_MODEL_JSON="$(printf '%s' "$cm_out" | python3 -c \
      'import json,sys; d=json.load(sys.stdin)
lf=[f for f in d.get("findings",[]) if f.get("severity") in ("low","info")]
print(json.dumps({"status":"partial","model":d.get("model"),"flags":[],"low_findings":[f.get("id") for f in lf]}))' 2>/dev/null \
      || echo '{"status":"partial","model":null,"flags":[]}')"
  else
    # CONTRADICTORY -- emit a [FLAG] line per medium+ finding
    while IFS= read -r fline; do
      [ -n "$fline" ] || continue
      CROSS_MODEL_LINES+=("[FLAG] cross-model raised: ${fline}")
      flags+=("$fline")
    done <<< "$medium_plus"
    local flags_json
    flags_json="$(printf '%s\n' "${flags[@]}" | python3 -c \
      'import json,sys; print(json.dumps([l for l in sys.stdin.read().splitlines() if l]))' 2>/dev/null \
      || echo '[]')"
    CROSS_MODEL_JSON="$(CM_OUT="$cm_out" CM_FLAGS="$flags_json" python3 -c '
import json, os
d = json.loads(os.environ["CM_OUT"])
flags = json.loads(os.environ["CM_FLAGS"])
print(json.dumps({"status":"contradictory","model":d.get("model"),"flags":flags}))
' 2>/dev/null || echo "{\"status\":\"contradictory\",\"model\":null,\"flags\":${flags_json}}")"
  fi
}

# Optional skill regression check (--skill-check flag). Runs scripts/skill-regression.sh
# against the live ~/.claude/skills/ path and adds SKILL_CHECK advisory section to the bundle.
# Advisory: result populates SKILL_CHECK_LINES/JSON but does NOT touch CHECK_STATUSES
# and therefore does NOT change the PASS/WARN/BLOCK verdict (skill regressions are separate
# from PR code quality -- same pattern as check_cross_model). Fail-open.
check_skill_regression() {
  local script="$INSTALL_DIR/scripts/skill-regression.sh"
  if [ ! -x "$script" ]; then
    SKILL_CHECK_LINES+=("[skill-check] skill-regression.sh not found or not executable; skipping [advisory]")
    SKILL_CHECK_JSON='{"status":"warn","detail":"script not found"}'
    return 0
  fi
  local sr_out sr_rc
  sr_out="$(bash "$script" 2>&1)"; sr_rc=$?
  local last_line; last_line="$(printf '%s\n' "$sr_out" | grep '^SKILL-REGRESSION:' | tail -1)"
  [ -z "$last_line" ] && last_line="SKILL-REGRESSION: (no output)"
  local status
  case "$sr_rc" in
    0) status="pass" ;;
    2) status="warn" ;;
    *) status="warn"; last_line="SKILL-REGRESSION returned rc=$sr_rc -- $last_line" ;;
  esac
  SKILL_CHECK_LINES+=("[skill-check] ${last_line} [advisory]")
  SKILL_CHECK_JSON="$(STATUS="$status" DETAIL="$last_line" python3 -c '
import json, os
print(json.dumps({"status": os.environ["STATUS"], "detail": os.environ["DETAIL"]}))
' 2>/dev/null || echo "{\"status\":\"$status\",\"detail\":\"(encode error)\"}")"
}

# DA T1 trigger-enforcement advisory (spec: store/specs/devil-advocate-agent.md, M2).
# Emits a WARN line (advisory -- NEVER changes the verdict/exit code) when no DA T1
# sentinel exists in DA_RUNS_DIR. This is an "any T1 sentinel present" check, not
# spec-id specific: once any T1 run has completed fleet-wide the advisory goes quiet.
# Always-on (no flag) so the nudge cannot be silently opted out of for a gate request.
# Note: labelled [da-trigger], distinct from the [skill-check] SKILL_CHECK advisory.
check_da_sentinel() {
  if [ -n "$(ls "$DA_RUNS_DIR"/T1-*.json 2>/dev/null)" ]; then
    DA_SENTINEL_LINES+=("[da-trigger] DA T1 sentinel present [advisory]")
    DA_SENTINEL_JSON='{"status":"present"}'
  else
    DA_SENTINEL_LINES+=("[da-trigger] WARN: DA T1 not triggered (no ${DA_RUNS_DIR}/T1-*.json) [advisory]")
    DA_SENTINEL_JSON='{"status":"warn","detail":"DA T1 not triggered"}'
  fi
}

# --------------------------------------------------------------------------- #
# Notify (inter-agent message; never affects the verdict/exit code)            #
# --------------------------------------------------------------------------- #
pgb_notify() {  # recipient verdict summary
  local to="$1" verdict="$2" summary="$3"
  local tokfile="$INSTALL_DIR/store/.dashboard-token"
  if [ ! -f "$tokfile" ]; then
    echo "[pre-gate-bundle] no dashboard token; --notify skipped" >&2
    return 0
  fi
  local token; token="$(cat "$tokfile")"
  local payload
  payload="$(TO="$to" VERDICT="$verdict" SUMMARY="$summary" python3 -c '
import json, os
print(json.dumps({
    "from": "dave",
    "to": os.environ["TO"],
    "content": "[pre-gate-bundle] verdict=%s -- %s" % (os.environ["VERDICT"], os.environ["SUMMARY"]),
}))')"
  curl -sf -X POST http://localhost:3420/api/messages \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $token" \
    -d "$payload" >/dev/null 2>&1 \
    && echo "[pre-gate-bundle] notified ${to}" >&2 \
    || echo "[pre-gate-bundle] notify to ${to} failed (dashboard down?)" >&2
  return 0
}

# --------------------------------------------------------------------------- #
# main                                                                         #
# --------------------------------------------------------------------------- #
usage() {
  echo "usage: pre-gate-bundle.sh <base-branch> <head-sha> [--json] [--notify[=agent]] [--cross-model] [--skill-check]" >&2
  exit 64
}

main() {
  local json=0 notify="" base="" head="" cross_model=0 skill_check=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --json)          json=1 ;;
      --notify)        notify="marveen" ;;
      --notify=*)      notify="${arg#--notify=}" ;;
      --cross-model)   cross_model=1 ;;
      --skill-check)   skill_check=1 ;;
      -h|--help)       usage ;;
      --*)             echo "unknown flag: $arg" >&2; usage ;;
      *)
        if [ -z "$base" ]; then base="$arg"
        elif [ -z "$head" ]; then head="$arg"
        else echo "unexpected argument: $arg" >&2; usage
        fi ;;
    esac
  done
  [ -n "$base" ] && [ -n "$head" ] || usage

  # Ensure the remote tip is up-to-date so the 3-dot diff does not pick up
  # intermediate commits from a stale local branch. If the caller passes a bare
  # branch name (e.g. "develop"), resolve it to origin/<branch> so git diff
  # always compares against the remote ancestor, not a potentially-behind local ref.
  # The fetch stays FAIL-OPEN (a host with no network must still produce a bundle),
  # but it must not be SILENT: a swallowed failure previously left the run diffing
  # against an arbitrarily old on-disk origin/<branch> while printing the exact same
  # green output as a healthy run. Capture the outcome and report it as evidence.
  if git -C "$INSTALL_DIR" fetch origin --quiet 2>/dev/null; then
    BASE_ANCHOR="fetched"
  else
    BASE_ANCHOR="stale"
  fi
  if [[ "$base" != */* ]]; then
    base="origin/$base"
  fi
  if [ "$BASE_ANCHOR" = "stale" ]; then
    record base-fetch WARN "FAILED -- ${base}@$(git -C "$INSTALL_DIR" rev-parse --short "$base" 2>/dev/null || echo unknown) may be outdated; diff is NOT anchored to the current remote tip"
  fi

  BASE="$base"; HEAD="$head"; DIFF_ADDITIONS=0

  check_typecheck
  check_tests
  check_diff_size
  check_static
  check_gitleaks
  check_mock_integrity
  check_test_mutation
  [ "$cross_model" -eq 1 ] && check_cross_model
  [ "$skill_check" -eq 1 ] && check_skill_regression
  check_da_sentinel

  local verdict; verdict="$(pgb_verdict "${CHECK_STATUSES[@]}")"
  local summary
  summary="$(python3 -c '
import sys
names = sys.argv[1].split("\n"); st = sys.argv[2].split("\n")
print(", ".join("%s:%s" % (n, s) for n, s in zip(names, st)))
' "$(printf '%s\n' "${CHECK_NAMES[@]}")" "$(printf '%s\n' "${CHECK_STATUSES[@]}")")"

  if [ "$json" -eq 1 ]; then
    pgb_json "$verdict" "$DIFF_ADDITIONS"
  else
    echo "pre-gate bundle  ${BASE}...${HEAD}"
    local i
    for i in "${!CHECK_NAMES[@]}"; do
      printf '  [%-5s] %-10s %s\n' "${CHECK_STATUSES[$i]}" "${CHECK_NAMES[$i]}" "${CHECK_DETAILS[$i]}"
    done
    for line in "${CROSS_MODEL_LINES[@]}"; do
      echo "  ${line}"
    done
    for line in "${SKILL_CHECK_LINES[@]}"; do
      echo "  ${line}"
    done
    for line in "${DA_SENTINEL_LINES[@]}"; do
      echo "  ${line}"
    done
    echo "  verdict: ${verdict}"
  fi

  [ -n "$notify" ] && pgb_notify "$notify" "$verdict" "$summary"

  exit "$(pgb_exit_code "$verdict")"
}

# Sourcing (for unit tests) defines the functions without running main.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
