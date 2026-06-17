#!/usr/bin/env bash
# Install gitleaks v8.30.1 into scripts/bin/ (gitignored).
# Called manually once per host, or re-run to upgrade.
# SHA256 verified before install.
set -euo pipefail

GITLEAKS_VERSION="8.30.1"
GITLEAKS_URL="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/bin"
TARGET="${BIN_DIR}/gitleaks"

mkdir -p "$BIN_DIR"

if [[ -x "$TARGET" ]] && "$TARGET" version 2>/dev/null | grep -q "^${GITLEAKS_VERSION}$"; then
  echo "gitleaks ${GITLEAKS_VERSION} already installed at ${TARGET}"
  exit 0
fi

TMPFILE="$(mktemp /tmp/gitleaks.XXXXXX.tar.gz)"
trap 'rm -f "$TMPFILE"' EXIT

echo "Downloading gitleaks ${GITLEAKS_VERSION}..."
curl -sL --fail "$GITLEAKS_URL" -o "$TMPFILE"

echo "Verifying SHA256..."
echo "${GITLEAKS_SHA256}  ${TMPFILE}" | sha256sum -c -

tar -xzf "$TMPFILE" -C "$BIN_DIR" gitleaks
chmod +x "$TARGET"

echo "Installed: $("$TARGET" version)"
