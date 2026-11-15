#!/usr/bin/env bash
# Install gh (GitHub CLI) v2.104.0 into scripts/bin/ (gitignored).
# Called manually once per host, or re-run to upgrade. SHA256 verified.
#
# Used only by scripts/gh-read.py -- the READ-only gh wrapper (card 24b12610).
# The binary is pinned so every agent runs the same gh; writes are refused in
# the wrapper, not relied on gh's own behaviour.
set -euo pipefail

GH_VERSION="2.104.0"
GH_URL="https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz"
GH_SHA256="98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${SCRIPT_DIR}/bin"
TARGET="${BIN_DIR}/gh"

mkdir -p "$BIN_DIR"

if [[ -x "$TARGET" ]] && "$TARGET" --version 2>/dev/null | grep -q "gh version ${GH_VERSION}"; then
  echo "gh ${GH_VERSION} already installed at ${TARGET}"
  exit 0
fi

TMPFILE="$(mktemp /tmp/gh.XXXXXX.tar.gz)"
TMPDIR_X="$(mktemp -d /tmp/gh-extract.XXXXXX)"
trap 'rm -rf "$TMPFILE" "$TMPDIR_X"' EXIT

echo "Downloading gh ${GH_VERSION}..."
curl -sL --fail "$GH_URL" -o "$TMPFILE"

echo "Verifying SHA256 (expected: ${GH_SHA256})..."
echo "${GH_SHA256}  ${TMPFILE}" | sha256sum -c -

# The tarball extracts to gh_<ver>_linux_amd64/bin/gh (nested, unlike gitleaks).
tar -xzf "$TMPFILE" -C "$TMPDIR_X"
cp "${TMPDIR_X}/gh_${GH_VERSION}_linux_amd64/bin/gh" "$TARGET"
chmod +x "$TARGET"

echo "Installed: $("$TARGET" --version | head -1)"
