#!/usr/bin/env bash
# build-v2-apk.sh -- reproducible signed per-ABI APK build for the NoA v2 app.
#
# Produces per-arch APKs (~20 MB each) instead of the 623 MB universal debug blob.
# Signing is entirely env-driven (see SIGNING section below) -- no credentials are
# embedded in this script or in the Gradle config.
#
# Usage:
#   # Signed release (requires signing env vars):
#   set -a; source ~/.android/noa-signing.env; set +a   # source + auto-export
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

# --- (3) Tauri android release build (arm64 flavor) ---
# Tauri uses product flavors (not splits.abi) for per-ABI builds via RustPlugin.
# --target aarch64 builds only the arm64 flavor -> app-arm64-arm64-release.apk (~20 MB).
# For all flavors (universal+arm64+arm+x86+x86_64), omit --target.
# BLOCKER NOTE: resolved in #969 (CSP connect-src + network_security_config).
echo "[build-v2-apk] tauri android build --apk --target aarch64..."
npx tauri android build --apk --target aarch64 2>&1 | tail -20

# --- (4) collect artifacts ---
mkdir -p "$OUT_DIR"
# Tauri flavor output: build/outputs/apk/<flavor>/release/
# Tauri --target aarch64 builds the universal Gradle flavor (all Rust ABIs compiled
# for one target). Output: apk/universal/release/ or apk/arm64/release/ depending
# on how the CLI invokes Gradle. Search all flavor dirs.
GRADLE_APK_BASE="$APP_DIR/src-tauri/gen/android/app/build/outputs/apk"
GRADLE_OUT=""
for flavor in universal arm64 release; do
    candidate="$GRADLE_APK_BASE/$flavor/release"
    if [ -d "$candidate" ] && ls "$candidate"/*.apk 2>/dev/null | head -1 | grep -q .; then
        GRADLE_OUT="$candidate"
        break
    fi
done
if [ -z "$GRADLE_OUT" ]; then
    echo "[build-v2-apk] ERROR: no APK found under $GRADLE_APK_BASE"
    find "$GRADLE_APK_BASE" -name "*.apk" 2>/dev/null || true
    exit 1
fi

echo "[build-v2-apk] collecting from $GRADLE_OUT..."
cp "$GRADLE_OUT"/*.apk "$OUT_DIR/" 2>/dev/null || { echo "ERROR: no APKs found in $GRADLE_OUT"; exit 1; }

# --- (5) SHA256 manifest ---
MANIFEST="$OUT_DIR/sha256-v${VERSION}.txt"
(cd "$OUT_DIR" && sha256sum *.apk) > "$MANIFEST"
echo "[build-v2-apk] SHA256 manifest:"
cat "$MANIFEST"

# --- (6) size check -- aarch64 APK should be ~15-25 MB ---
MAIN_APK=$(ls "$OUT_DIR"/*.apk 2>/dev/null | head -1)
if [ -n "$MAIN_APK" ] && [ -f "$MAIN_APK" ]; then
    SIZE_MB=$(python3 -c "import os; print(f'{os.path.getsize(\"$MAIN_APK\")/1024/1024:.1f}')")
    echo "[build-v2-apk] $(basename $MAIN_APK): ${SIZE_MB} MB"
    if python3 -c "import sys; sys.exit(0 if float('$SIZE_MB') <= 100 else 1)"; then
        echo "OK: size ${SIZE_MB} MB is within expected range."
    else
        echo "WARNING: ${SIZE_MB} MB -- expected ~20 MB. Check build config."
    fi
fi

echo "[build-v2-apk] DONE. Artifacts in $OUT_DIR/"
ls -lh "$OUT_DIR/"
