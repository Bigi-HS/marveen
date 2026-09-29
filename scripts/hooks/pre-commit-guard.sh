#!/usr/bin/env bash
# Pre-commit guard: block direct commits to develop / main (card f7b6c1d6).
#
# The fleet workflow is ALWAYS feature-branch + PR + gate.  Committing directly
# to develop or main bypasses peer review and the gating process -- the incident
# (2026-09-29 02:53) showed that even a well-intentioned Haiku heartbeat can
# land broken code on the shared checkout this way.
#
# ESCAPE HATCH (operator-only, use sparingly):
#   ALLOW_DIRECT_COMMIT=1 git commit ...
# Log the override reason in your commit message so it is auditable.

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)

BLOCKED_BRANCHES="develop main HEAD"

for blocked in $BLOCKED_BRANCHES; do
    if [ "$BRANCH" = "$blocked" ]; then
        if [ -n "$ALLOW_DIRECT_COMMIT" ]; then
            echo "[pre-commit-guard] OVERRIDE active (ALLOW_DIRECT_COMMIT=1). Committing to $BRANCH." >&2
            exit 0
        fi
        echo "---" >&2
        echo "[pre-commit-guard] BLOCKED: direct commit to '$BRANCH' is not allowed." >&2
        echo "" >&2
        echo "  Fleet rule: all changes go through a feature branch + PR + gate." >&2
        echo "  1. Create a feature branch:  git checkout -b feat/your-description" >&2
        echo "  2. Commit there, then open a PR against develop." >&2
        echo "  3. Gate approval before merge." >&2
        echo "" >&2
        echo "  Emergency override (operator only): ALLOW_DIRECT_COMMIT=1 git commit ..." >&2
        echo "---" >&2
        exit 1
    fi
done

exit 0
