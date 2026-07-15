#!/usr/bin/env bash
#
# dev-browser-connect.sh -- env-compat launcher for the `dev-browser` CLI.
#
# WHY THIS EXISTS
# The globally-installed dev-browser daemon bundles playwright-core 1.58.2,
# whose default Chromium build (revision 1208) has no download for this host
# (Ubuntu 26.04): `playwright install chromium` fails with
#   "Playwright does not support chromium on ubuntu26.04-x64".
# So the daemon-launched browser path is dead until upstream bumps Playwright.
#
# This repo, however, already ships a working Chromium (revision 1228, from
# playwright 1.61.0) under ~/.cache/ms-playwright. dev-browser's `--connect`
# mode speaks CDP to an external Chrome and does NOT require a matching bundled
# build, so we launch that Chromium ourselves with a remote-debugging port and
# attach to it. This sidesteps the daemon's own browser download entirely.
#
# USAGE
#   scripts/dev-browser-connect.sh <<'EOF'
#     const page = await browser.getPage("main");
#     await page.goto("https://example.com");
#     console.log(await page.title());
#   EOF
#
#   scripts/dev-browser-connect.sh run script.js
#   echo '...' | scripts/dev-browser-connect.sh --timeout 60
#   scripts/dev-browser-connect.sh stop    # tear down the managed Chrome
#
# Any arguments are forwarded verbatim to `dev-browser --connect <url> ...`.
# The managed Chrome is started once and reused across invocations; it stays up
# until `stop`, a reboot, or its idle death. `--connect` never auto-closes it.
#
set -euo pipefail

PORT="${DEV_BROWSER_CDP_PORT:-9222}"
CDP_URL="http://127.0.0.1:${PORT}"
PROFILE_DIR="${DEV_BROWSER_CONNECT_PROFILE:-${HOME}/.dev-browser/connect-profile}"
CHROME_LOG="${HOME}/.dev-browser/connect-chrome.log"
LOCK_FILE="${HOME}/.dev-browser/connect.lock"

log() { printf '[dev-browser-connect] %s\n' "$*" >&2; }

# Resolve the newest managed Chromium binary, tolerating both the modern
# (chrome-linux64) and legacy (chrome-linux) Playwright layouts.
#
# Sort by the numeric revision from the basename (chromium-<rev>), newest first.
# Sorting on the full path with `-t- -k<n>` is unreliable: the cache path itself
# contains a hyphen (ms-playwright), so the revision lands in a field whose
# index depends on the path -- it silently mis-orders once a second Chromium
# revision appears (exactly what an upstream Playwright bump will add).
resolve_chrome() {
  local cache="${HOME}/.cache/ms-playwright"
  local dir bin
  for dir in $(ls -d "${cache}"/chromium-* 2>/dev/null \
      | sed -E 's#.*/chromium-([0-9]+)$#\1 &#' \
      | sort -rn \
      | cut -d' ' -f2-); do
    for bin in "${dir}/chrome-linux64/chrome" "${dir}/chrome-linux/chrome"; do
      if [[ -x "${bin}" ]]; then
        printf '%s\n' "${bin}"
        return 0
      fi
    done
  done
  return 1
}

resolve_dev_browser() {
  if command -v dev-browser >/dev/null 2>&1; then
    command -v dev-browser
    return 0
  fi
  local fallback="${HOME}/.npm-global/lib/node_modules/dev-browser/bin/dev-browser-linux-x64"
  if [[ -x "${fallback}" ]]; then
    printf '%s\n' "${fallback}"
    return 0
  fi
  return 1
}

cdp_up() {
  curl -sf --max-time 2 "${CDP_URL}/json/version" >/dev/null 2>&1
}

stop_chrome() {
  local pids
  pids="$(pgrep -f "remote-debugging-port=${PORT}" || true)"
  if [[ -z "${pids}" ]]; then
    log "no managed Chrome on port ${PORT}"
    return 0
  fi
  log "stopping managed Chrome (pids: $(echo "${pids}" | tr '\n' ' '))"
  # Kill each matched process; children exit with the browser main.
  echo "${pids}" | while read -r pid; do
    [[ -n "${pid}" ]] && kill "${pid}" 2>/dev/null || true
  done
}

ensure_chrome() {
  if cdp_up; then
    return 0
  fi
  local chrome
  if ! chrome="$(resolve_chrome)"; then
    log "ERROR: no managed Chromium under ~/.cache/ms-playwright (run a Playwright install in the repo first)"
    exit 3
  fi
  mkdir -p "$(dirname "${CHROME_LOG}")" "${PROFILE_DIR}"

  # Serialize concurrent launches so we never start two Chromes on one port.
  exec 9>"${LOCK_FILE}"
  flock 9
  if cdp_up; then
    return 0   # another invocation won the race
  fi

  log "launching Chromium: ${chrome} (CDP ${CDP_URL})"
  nohup "${chrome}" \
    --headless=new \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="${PORT}" \
    --user-data-dir="${PROFILE_DIR}" \
    about:blank >"${CHROME_LOG}" 2>&1 &
  disown || true

  local i
  for i in $(seq 1 30); do
    if cdp_up; then
      log "Chromium ready after $((i * 500))ms"
      return 0
    fi
    sleep 0.5
  done
  log "ERROR: Chromium did not expose CDP on ${CDP_URL} within 15s"
  log "--- last Chrome log lines ---"
  tail -n 10 "${CHROME_LOG}" >&2 || true
  exit 5
}

main() {
  if [[ "${1:-}" == "stop" ]]; then
    stop_chrome
    exit 0
  fi

  local dev_browser
  if ! dev_browser="$(resolve_dev_browser)"; then
    log "ERROR: dev-browser CLI not found (npm install -g dev-browser)"
    exit 4
  fi

  ensure_chrome
  exec "${dev_browser}" --connect "${CDP_URL}" "$@"
}

main "$@"
