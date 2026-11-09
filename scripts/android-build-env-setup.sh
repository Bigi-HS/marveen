#!/usr/bin/env bash
# Android build-env setup for WSL (no sudo required).
# Installs: JDK 17 (Temurin), Android SDK cmdline-tools, build-tools, NDK r25c.
# All artifacts land in ~/Android/ and ~/.java/.
#
# Usage: bash scripts/android-build-env-setup.sh
# After first run, source the env additions or add them to ~/.bashrc:
#   source ~/Android/.android-env.sh
#
# Tauri android init must be run after this script completes:
#   cd dashboard-new && npm run tauri:android:init

set -euo pipefail

ANDROID_DIR="$HOME/Android"
SDK_DIR="$ANDROID_DIR/Sdk"
JAVA_DIR="$HOME/.java/jdk17"
CMDLINE_TOOLS_DIR="$SDK_DIR/cmdline-tools/latest"

JDK_URL="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.13%2B11/OpenJDK17U-jdk_x64_linux_hotspot_17.0.13_11.tar.gz"
JDK_TAR="$ANDROID_DIR/jdk17.tar.gz"

CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
CMDLINE_TOOLS_ZIP="$ANDROID_DIR/cmdline-tools.zip"

mkdir -p "$JAVA_DIR" "$SDK_DIR" "$CMDLINE_TOOLS_DIR"

echo "=== Step 1: JDK 17 (Temurin) ==="
if [ ! -f "$JAVA_DIR/bin/java" ]; then
    echo "Downloading JDK 17..."
    curl -L --progress-bar "$JDK_URL" -o "$JDK_TAR"
    echo "Extracting JDK..."
    tar -xzf "$JDK_TAR" -C "$JAVA_DIR" --strip-components=1
    rm "$JDK_TAR"
else
    echo "JDK 17 already installed at $JAVA_DIR"
fi

echo "=== Step 2: Android Command Line Tools ==="
if [ ! -f "$CMDLINE_TOOLS_DIR/bin/sdkmanager" ]; then
    echo "Downloading Android cmdline-tools..."
    curl -L --progress-bar "$CMDLINE_TOOLS_URL" -o "$CMDLINE_TOOLS_ZIP"
    echo "Extracting cmdline-tools..."
    # Zip extracts as cmdline-tools/bin/... but sdkmanager requires the
    # directory to be named 'latest'. Extract to a temp dir then move.
    TMP_EXTRACT="$SDK_DIR/cmdline-tools/_tmp"
    mkdir -p "$TMP_EXTRACT"
    unzip -q "$CMDLINE_TOOLS_ZIP" -d "$TMP_EXTRACT"
    # The zip contains a top-level 'cmdline-tools/' directory
    if [ -d "$TMP_EXTRACT/cmdline-tools" ]; then
        mv "$TMP_EXTRACT/cmdline-tools" "$CMDLINE_TOOLS_DIR"
    fi
    rm -rf "$TMP_EXTRACT"
    rm "$CMDLINE_TOOLS_ZIP"
else
    echo "Android cmdline-tools already installed"
fi

echo "=== Step 3: SDK platforms + build-tools + NDK ==="
export JAVA_HOME="$JAVA_DIR"
export PATH="$JAVA_HOME/bin:$CMDLINE_TOOLS_DIR/bin:$PATH"
export ANDROID_HOME="$SDK_DIR"

# Accept licenses non-interactively
yes | sdkmanager --licenses > /dev/null 2>&1 || true

# Install required packages for Tauri Android build
sdkmanager \
    "platform-tools" \
    "platforms;android-34" \
    "build-tools;34.0.0" \
    "ndk;25.2.9519653"

echo "=== Step 4: Write env file ==="
cat > "$ANDROID_DIR/.android-env.sh" << ENVEOF
export JAVA_HOME="$JAVA_DIR"
export ANDROID_HOME="$SDK_DIR"
export ANDROID_NDK_HOME="$SDK_DIR/ndk/25.2.9519653"
export PATH="\$JAVA_HOME/bin:\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$PATH"
ENVEOF

echo ""
echo "=== Done ==="
echo "Add to ~/.bashrc:"
echo "  source ~/Android/.android-env.sh"
echo ""
echo "Then run tauri android init:"
echo "  cd dashboard-new && source ~/Android/.android-env.sh && npm run tauri:android:init"
