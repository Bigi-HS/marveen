#!/usr/bin/env bash
# Install fleet git hooks into .git/hooks/.
# Run once per checkout (new clone or new agent workspace).
# Safe to re-run: hooks are overwritten with the tracked version.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GIT_HOOKS_DIR="$REPO_ROOT/.git/hooks"

if [ ! -d "$GIT_HOOKS_DIR" ]; then
    echo "Not a git repository (no .git/hooks found): $REPO_ROOT" >&2
    exit 1
fi

HOOKS=(
    "pre-commit:pre-commit-guard.sh"
)

for mapping in "${HOOKS[@]}"; do
    hook_name="${mapping%%:*}"
    source_file="${mapping##*:}"
    src="$SCRIPT_DIR/hooks/$source_file"
    dst="$GIT_HOOKS_DIR/$hook_name"

    if [ ! -f "$src" ]; then
        echo "SKIP $hook_name -- source not found: $src" >&2
        continue
    fi

    cp "$src" "$dst"
    chmod +x "$dst"
    echo "INSTALLED $hook_name -> $dst"
done

echo "Done. Run 'git commit' to verify the hooks are active."
