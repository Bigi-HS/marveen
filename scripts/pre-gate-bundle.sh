#!/usr/bin/env bash
# pre-gate-bundle.sh -- mechanical pre-gate evidence bundle (Thor card b45884fb).
#
# Runs four DETERMINISTIC checks against a PR (base-branch ... head-sha) and emits a
# single verdict (PASS / WARN / BLOCK) plus per-check evidence. The point is to hand
# the merge gate (Thor + Dave [+ Chad]) a uniform, reproducible evidence sheet instead
# of ad-hoc "I ran the tests" claims.
#
# Checks:
#   typecheck  `npx tsc --noEmit`               -- type errors -> BLOCK; tooling missing -> WARN
#   tests      `npx vitest run` (worktrees excl) -- any failure -> BLOCK; runner missing -> WARN
#   diff-size  `git diff --numstat base...head`  -- additions count; over threshold -> WARN
#   static     secret + unused-export grep       -- hardcoded secret -> BLOCK; unused export -> WARN
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
}
print(json.dumps(out, indent=2))
PY
}

# --------------------------------------------------------------------------- #
# Check accumulator                                                            #
# --------------------------------------------------------------------------- #
CHECK_NAMES=()
CHECK_STATUSES=()
CHECK_DETAILS=()

record() {  # name status detail
  CHECK_NAMES+=("$1")
  CHECK_STATUSES+=("$2")
  CHECK_DETAILS+=("$3")
}

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
  echo "usage: pre-gate-bundle.sh <base-branch> <head-sha> [--json] [--notify[=agent]]" >&2
  exit 64
}

main() {
  local json=0 notify="" base="" head=""
  local arg
  for arg in "$@"; do
    case "$arg" in
      --json)        json=1 ;;
      --notify)      notify="marveen" ;;
      --notify=*)    notify="${arg#--notify=}" ;;
      -h|--help)     usage ;;
      --*)           echo "unknown flag: $arg" >&2; usage ;;
      *)
        if [ -z "$base" ]; then base="$arg"
        elif [ -z "$head" ]; then head="$arg"
        else echo "unexpected argument: $arg" >&2; usage
        fi ;;
    esac
  done
  [ -n "$base" ] && [ -n "$head" ] || usage

  BASE="$base"; HEAD="$head"; DIFF_ADDITIONS=0

  check_typecheck
  check_tests
  check_diff_size
  check_static

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
    echo "  verdict: ${verdict}"
  fi

  [ -n "$notify" ] && pgb_notify "$notify" "$verdict" "$summary"

  exit "$(pgb_exit_code "$verdict")"
}

# Sourcing (for unit tests) defines the functions without running main.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
