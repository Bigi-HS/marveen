#!/usr/bin/env bash
# build-v2-apk.sh -- reproducible signed per-ABI APK build for the NoA v2 app.
#
# Produces per-arch APKs (~20 MB each) instead of the 623 MB universal debug blob.
# Signing is entirely env-driven (see SIGNING section below) -- no credentials are
# embedded in this script or in the Gradle config.
#
# Usage:
#   # Signed release (requires signing env vars):
#   source ~/.android/noa-signing.env   # sets ANDROID_KEYSTORE_* vars
#   bash scripts/build-v2-apk.sh
#
#   # Unsigned (CI smoke, not shippable):
#   bash scripts/build-v2-apk.sh
#
# Output: out/apk/ contains the signed (or unsigned) APKs + SHA256 manifest.
#
# SIGNING env vars (all 4 required for a signed build):
#   ANDROID_KEYSTORE_PATH  -- absolute path to the upload .jks file (~/.android/noa-upload.jks)
#   ANDROID_KEYSTORE_PASS  -- keystore password
#   ANDROID_KEY_ALIAS      -- key alias (noa-upload)
#   ANDROID_KEY_PASS       -- key password
#
# WARNING: gen/android/ is Tauri-generated. If `tauri android init` is re-run it
# overwrites gen/android/app/build.gradle.kts. Re-apply the git-tracked diff before
# building release (the diff lives in this repo; `git diff HEAD -- dashboard-new/`).
#
# Prerequisites: Java 17, Rust + 4 android targets, Android SDK + NDK 25, Node.js.
# Tested with Tauri CLI 2.12.4 (npx), NDK 25.2.9519653, Rust 1.99.1.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/dashboard-new"
OUT_DIR="$REPO_ROOT/out/apk"
TAURI_CONF="$APP_DIR/src-tauri/tauri.conf.json"

# --- toolchain env ---
export JAVA_HOME="${JAVA_HOME:-$HOME/.java/jdk17}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/25.2.9519653}"
export PATH="$HOME/.cargo/bin:$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

# --- version from tauri.conf.json ---
VERSION=$(python3 -c "import json; print(json.load(open('$TAURI_CONF'))['version'])" 2>/dev/null || echo "unknown")
echo "[build-v2-apk] version=$VERSION  signed=$([ -n "${ANDROID_KEYSTORE_PATH:-}" ] && echo yes || echo no)"

# --- (1) install frontend deps ---
echo "[build-v2-apk] npm ci..."
cd "$APP_DIR"
npm ci --prefer-offline 2>&1 | tail -5

# --- (2) vite frontend build ---
echo "[build-v2-apk] vite build..."
npm run build 2>&1 | tail -5

# --- (3) Tauri android release build (all 3 ABI targets) ---
# --apk builds APKs (not AAB). ABI splits are configured in build.gradle.kts.
# BLOCKER NOTE (resolve before shipping to Boss):
#   BLOCKER 1: CSP connect-src must include the Tailscale backend origin.
#   BLOCKER 2: cleartext traffic policy (plain-http Tailscale vs https+MagicDNS).
#   These are tracked and being resolved with Dave/NoA separately; this script
#   builds the binary layer regardless of network-config state.
echo "[build-v2-apk] tauri android build --apk..."
npx tauri android build --apk 2>&1 | tail -20

# --- (4) collect artifacts ---
mkdir -p "$OUT_DIR"
GRADLE_OUT="$APP_DIR/src-tauri/gen/android/app/build/outputs/apk/release"

if [ ! -d "$GRADLE_OUT" ]; then
    echo "[build-v2-apk] ERROR: Gradle output dir not found: $GRADLE_OUT"
    exit 1
fi

echo "[build-v2-apk] copying APKs to $OUT_DIR..."
cp "$GRADLE_OUT"/*.apk "$OUT_DIR/" 2>/dev/null || { echo "ERROR: no APKs found in $GRADLE_OUT"; exit 1; }

# --- (5) SHA256 manifest ---
MANIFEST="$OUT_DIR/sha256-v${VERSION}.txt"
(cd "$OUT_DIR" && sha256sum *.apk) > "$MANIFEST"
echo "[build-v2-apk] SHA256 manifest:"
cat "$MANIFEST"

# --- (6) size check -- arm64-v8a should be ~20 MB, not 623 MB ---
ARM64="$OUT_DIR/app-arm64-v8a-release.apk"
if [ -f "$ARM64" ]; then
    SIZE_MB=$(python3 -c "import os; print(f'{os.path.getsize(\"$ARM64\")/1024/1024:.1f}')")
    echo "[build-v2-apk] arm64-v8a: ${SIZE_MB} MB"
    python3 -c "
size = $(python3 -c "import os; print(os.path.getsize('$ARM64')/1024/1024)")
if size > 100:
    print(f'WARNING: arm64-v8a is {size:.1f} MB -- expected ~20 MB for a split APK. Check ABI splits config.')
else:
    print(f'OK: arm64-v8a size {size:.1f} MB is within expected range.')
"
fi

echo "[build-v2-apk] DONE. Artifacts in $OUT_DIR/"
ls -lh "$OUT_DIR/"
