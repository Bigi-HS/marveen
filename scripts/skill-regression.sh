#!/usr/bin/env bash
# skill-regression.sh -- deterministic regression harness for the top 10 fleet skills.
#
# Scans ~/.claude/skills/ live path. No LLM grader, no auto-fix, no PR-diff dependency.
# Each skill runs all checks; a single BLOCK does NOT halt the others (AC7).
#
# Exit codes (AC5):
#   0 = all PASS
#   1 = >=1 BLOCK
#   2 = >=1 WARN, no BLOCKs
#
# Last-line format (AC5):
#   SKILL-REGRESSION: PASS|WARN|BLOCK (N/10 ok)
#
# After every run writes store/skill-regression-last.json (AC6c).
#
# Usage:
#   bash scripts/skill-regression.sh
set -uo pipefail

SKILLS_DIR="${SKILL_REGRESSION_DIR:-$HOME/.claude/skills}"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAST_JSON="$INSTALL_DIR/store/skill-regression-last.json"

TOP10=(
  fleet-ops
  fleet-pr-merge-gate
  fleet-deploy-verify
  security-audit
  unstick-wedged-agent
  pre-gate-evidence-bundle
  ephemeral-eng-workflow
  fleet-meeting
  spawn-fleet-subagent
  c12-chameleon-test
)

# --------------------------------------------------------------------------- #
# AC2: per-skill required keywords (BLOCK if any missing)                     #
# --------------------------------------------------------------------------- #
declare -A SKILL_KEYWORDS
SKILL_KEYWORDS[fleet-ops]="store/.dashboard-token localhost:3420 kanban_cards"
SKILL_KEYWORDS[fleet-pr-merge-gate]="mergeable urllib merge_method Bigi-HS/marveen"
SKILL_KEYWORDS[fleet-deploy-verify]="dist/index.js fleet-supervisor Genesis-GO"
SKILL_KEYWORDS[security-audit]="PASS FLAG BLOCK"
SKILL_KEYWORDS[unstick-wedged-agent]="capture-pane delivered_at"
SKILL_KEYWORDS[pre-gate-evidence-bundle]="tsc vitest"
SKILL_KEYWORDS[ephemeral-eng-workflow]="git worktree"
SKILL_KEYWORDS[fleet-meeting]="inter-agent"
SKILL_KEYWORDS[spawn-fleet-subagent]="CLAUDE_CONFIG_DIR"
SKILL_KEYWORDS[c12-chameleon-test]="buster"

# --------------------------------------------------------------------------- #
# Result accumulator                                                           #
# --------------------------------------------------------------------------- #
RESULT_LINES=()
TOTAL_BLOCKS=0
TOTAL_WARNS=0
TOTAL_PASS=0
declare -A SKILL_STATUS   # per-skill worst status: PASS | WARN | BLOCK

# Emit a result line and update counters.
result() {   # level skill message
  local lvl="$1" skill="$2" msg="$3"
  RESULT_LINES+=("$(printf '  [%-5s] %-30s %s' "$lvl" "$skill" "$msg")")
  case "$lvl" in
    BLOCK) TOTAL_BLOCKS=$((TOTAL_BLOCKS+1)) ;;
    WARN)  TOTAL_WARNS=$((TOTAL_WARNS+1)) ;;
    PASS)  TOTAL_PASS=$((TOTAL_PASS+1)) ;;
  esac
}

# --------------------------------------------------------------------------- #
# AC4: syntax check helpers                                                    #
# --------------------------------------------------------------------------- #

# Extract fenced code blocks of a given language from a file.
# Prints each block to stdout separated by a sentinel line.
extract_blocks() {   # file lang
  python3 - "$1" "$2" <<'PY'
import sys, re
content = open(sys.argv[1], encoding="utf-8", errors="replace").read()
lang = sys.argv[2]
pattern = re.compile(r"```" + re.escape(lang) + r"[ \t]*\n(.*?)```", re.DOTALL)
for m in pattern.finditer(content):
    print("---BLOCK---")
    print(m.group(1), end="")
PY
}

check_bash_syntax() {   # skill md_file -> emits result lines
  local skill="$1" md="$2"
  local blocks found=0
  blocks="$(extract_blocks "$md" "bash" 2>/dev/null)" || return 0
  [ -z "$blocks" ] && return 0
  local tmp; tmp="$(mktemp /tmp/skill-reg-bash.XXXXXX)"
  local block=""
  while IFS= read -r line; do
    if [ "$line" = "---BLOCK---" ]; then
      if [ -n "$block" ]; then
        # skip-syntax annotation?
        if echo "$block" | grep -q "# skill-regression: skip-syntax"; then
          block=""
          continue
        fi
        printf '%s\n' "$block" > "$tmp"
        if ! bash -n "$tmp" 2>/tmp/skill-reg-err; then
          local err; err="$(cat /tmp/skill-reg-err | head -3)"
          # Angle-bracket placeholders (<word>) cause bash -n false positives on usage/pseudocode.
          # Downgrade to WARN with a hint rather than BLOCK.
          if echo "$block" | grep -qE '<[A-Za-z_][A-Za-z0-9_-]*>'; then
            result WARN "$skill" "AC4: bash block with <placeholder> syntax (pseudocode? add '# skill-regression: skip-syntax')"
            skill_warn=$((skill_warn+1))
          else
            result BLOCK "$skill" "bash syntax error: $err"
            found=$((found+1))
          fi
        fi
        block=""
      fi
    else
      block="${block:+$block$'\n'}$line"
    fi
  done <<< "$blocks"
  # last block
  if [ -n "$block" ]; then
    if ! echo "$block" | grep -q "# skill-regression: skip-syntax"; then
      printf '%s\n' "$block" > "$tmp"
      if ! bash -n "$tmp" 2>/tmp/skill-reg-err; then
        local err; err="$(cat /tmp/skill-reg-err | head -3)"
        if echo "$block" | grep -qE '<[A-Za-z_][A-Za-z0-9_-]*>'; then
          result WARN "$skill" "AC4: bash block with <placeholder> syntax (pseudocode? add '# skill-regression: skip-syntax')"
        else
          result BLOCK "$skill" "bash syntax error: $err"
          found=$((found+1))
        fi
      fi
    fi
  fi
  rm -f "$tmp" /tmp/skill-reg-err
  return 0
}

check_python_syntax() {   # skill md_file -> emits result lines
  local skill="$1" md="$2"
  local blocks
  blocks="$(extract_blocks "$md" "python" 2>/dev/null)" || return 0
  [ -z "$blocks" ] && return 0
  local tmp; tmp="$(mktemp /tmp/skill-reg-py.XXXXXX.py)"
  local block=""
  local check_block
  check_block() {
    local b="$1"
    [ -z "$b" ] && return
    if echo "$b" | grep -q "# skill-regression: skip-syntax"; then return; fi
    printf '%s\n' "$b" > "$tmp"
    if ! python3 -c "compile(open('$tmp').read(), '$tmp', 'exec')" 2>/tmp/skill-reg-pyerr; then
      local err; err="$(cat /tmp/skill-reg-pyerr | head -3)"
      result BLOCK "$skill" "python syntax error: $err"
    fi
  }
  while IFS= read -r line; do
    if [ "$line" = "---BLOCK---" ]; then
      check_block "$block"
      block=""
    else
      block="${block:+$block$'\n'}$line"
    fi
  done <<< "$blocks"
  check_block "$block"
  rm -f "$tmp" /tmp/skill-reg-pyerr
  return 0
}

# --------------------------------------------------------------------------- #
# Per-skill check                                                              #
# --------------------------------------------------------------------------- #
check_skill() {
  local skill="$1"
  local md="$SKILLS_DIR/$skill/SKILL.md"
  local skill_block=0 skill_warn=0

  # Skill not found (AC1 prerequisite)
  if [ ! -f "$md" ]; then
    result BLOCK "$skill" "skill not found: $SKILLS_DIR/$skill/SKILL.md"
    return
  fi

  # AC1a -- frontmatter name:
  if ! grep -qE '^name:' "$md"; then
    result BLOCK "$skill" "AC1: frontmatter missing 'name:'"
    skill_block=$((skill_block+1))
  fi

  # AC1a -- frontmatter description:
  if ! grep -qE '^description:' "$md"; then
    result BLOCK "$skill" "AC1: frontmatter missing 'description:'"
    skill_block=$((skill_block+1))
  fi

  # AC1b -- required sections (>=3 of 4 named, OR >=4 H2 sections for reference-style skills)
  local sections=0
  grep -qiE 'Mikor haszn|When to use' "$md" && sections=$((sections+1))
  grep -qiE 'Eljárás|Eljaras|Procedure' "$md" && sections=$((sections+1))
  grep -qiE 'Buktatók|Buktatok|Pitfall' "$md" && sections=$((sections+1))
  grep -qiE 'Ellenőrzés|Ellenorzes|Validation' "$md" && sections=$((sections+1))
  local h2_count; h2_count="$(grep -cE '^## ' "$md" 2>/dev/null || echo 0)"
  if [ "$sections" -lt 3 ] && [ "$h2_count" -ge 4 ]; then
    # Reference-style skill with non-standard section names but well-structured (>=4 H2 headings).
    result WARN "$skill" "AC1: $sections/4 named sections (non-standard structure, $h2_count H2 headers ok)"
    skill_warn=$((skill_warn+1))
  elif [ "$sections" -lt 3 ]; then
    result BLOCK "$skill" "AC1: only $sections/4 required sections (and only $h2_count H2 headers)"
    skill_block=$((skill_block+1))
  elif [ "$sections" -eq 3 ]; then
    result WARN "$skill" "AC1: 3/4 sections (missing one optional section)"
    skill_warn=$((skill_warn+1))
  fi

  # AC2 -- per-skill critical keywords
  local kw_str="${SKILL_KEYWORDS[$skill]:-}"
  if [ -n "$kw_str" ]; then
    for kw in $kw_str; do
      if ! grep -qF "$kw" "$md"; then
        result BLOCK "$skill" "AC2: required keyword missing: '$kw'"
        skill_block=$((skill_block+1))
      fi
    done
  fi

  # AC3a -- bare 'gh' CLI (without disclaimer)
  local gh_bare; gh_bare="$(grep -nE '\bgh\s+(pr|repo|api|release)\b' "$md" 2>/dev/null || true)"
  if [ -n "$gh_bare" ]; then
    # Check if the file contains a "no gh CLI" disclaimer
    if grep -qiE 'no .gh.|gh.*absent|gh.*not (installed|available)|gh.*missing' "$md"; then
      result WARN "$skill" "AC3: 'gh' CLI reference present (disclaimer found -- WARN only)"
      skill_warn=$((skill_warn+1))
    else
      result BLOCK "$skill" "AC3: bare 'gh' CLI usage without disclaimer ($(echo "$gh_bare" | head -1 | cut -c1-80))"
      skill_block=$((skill_block+1))
    fi
  fi

  # AC3b -- piped jq
  if grep -qE '\|\s*jq\b|jq\s+\.' "$md"; then
    result BLOCK "$skill" "AC3: piped 'jq' usage (not available on this host)"
    skill_block=$((skill_block+1))
  fi

  # AC3c -- requests library
  if grep -qE 'import requests|requests\.(get|post|put|delete|patch)\(' "$md"; then
    result BLOCK "$skill" "AC3: 'requests' library usage (use urllib instead)"
    skill_block=$((skill_block+1))
  fi

  # AC3d -- legacy scheduled_tasks direct write
  if grep -qF "INSERT INTO scheduled_tasks" "$md"; then
    result BLOCK "$skill" "AC3: legacy direct SQLite write to scheduled_tasks"
    skill_block=$((skill_block+1))
  fi

  # AC4 -- syntax checks (capture global counters before/after to detect additions)
  local pre_blocks=$TOTAL_BLOCKS pre_warns=$TOTAL_WARNS
  check_bash_syntax "$skill" "$md"
  check_python_syntax "$skill" "$md"
  skill_block=$((skill_block + TOTAL_BLOCKS - pre_blocks))
  skill_warn=$((skill_warn + TOTAL_WARNS - pre_warns))

  # Summary for this skill
  if [ "$skill_block" -eq 0 ] && [ "$skill_warn" -eq 0 ]; then
    result PASS "$skill" "all checks ok"
    SKILL_STATUS[$skill]="PASS"
  elif [ "$skill_block" -gt 0 ]; then
    SKILL_STATUS[$skill]="BLOCK"
  else
    SKILL_STATUS[$skill]="WARN"
  fi
}

# --------------------------------------------------------------------------- #
# Main                                                                         #
# --------------------------------------------------------------------------- #
echo "skill-regression  ~/.claude/skills  (top ${#TOP10[@]} skills)"
echo ""

for skill in "${TOP10[@]}"; do
  check_skill "$skill"
done

echo ""
for line in "${RESULT_LINES[@]}"; do
  echo "$line"
done
echo ""

ok_count=0
for skill in "${TOP10[@]}"; do
  [ "${SKILL_STATUS[$skill]:-BLOCK}" = "PASS" ] && ok_count=$((ok_count+1))
done

# Determine overall verdict
if [ "$TOTAL_BLOCKS" -gt 0 ]; then
  VERDICT="BLOCK"
  EXIT_CODE=1
elif [ "$TOTAL_WARNS" -gt 0 ]; then
  VERDICT="WARN"
  EXIT_CODE=2
else
  VERDICT="PASS"
  EXIT_CODE=0
fi

LAST_LINE="SKILL-REGRESSION: $VERDICT (${ok_count}/${#TOP10[@]} ok)"
echo "$LAST_LINE"

# AC6c -- write last run JSON
python3 - <<PY 2>/dev/null || echo "[WARN] could not write $LAST_JSON" >&2
import json, os, time
data = {
    "timestamp": int(time.time()),
    "result": "$VERDICT",
    "ok": $ok_count,
    "total": ${#TOP10[@]},
    "summary": "$LAST_LINE",
    "blocks": $TOTAL_BLOCKS,
    "warns": $TOTAL_WARNS,
}
os.makedirs(os.path.dirname("$LAST_JSON"), exist_ok=True)
open("$LAST_JSON", "w").write(json.dumps(data, indent=2))
PY

exit "$EXIT_CODE"
