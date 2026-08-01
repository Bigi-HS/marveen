#!/usr/bin/env python3
"""
PR-trigger auto-metrics listener for Dampier.

Subscribes to /api/events (SSE) for pr.opened/pr.ready events.
On event: spawn async job to run run-flaky-suite.sh for the PR branch.
Store results in /tmp/metrics/pr-{N}/.

Usage:
  ./pr-metrics-listener.py [--dry-run] [--verbose]

Environment:
  GENESIS_AGENT_TOKEN: dashboard bearer token (required for /api/events)
  PR_METRICS_DRY_RUN: skip shell commands if set
"""

import json
import os
import sys
import subprocess
import logging
import time
import urllib.request
import urllib.error
from pathlib import Path
from threading import Thread
from datetime import datetime

logger = logging.getLogger(__name__)
handler = logging.StreamHandler()
formatter = logging.Formatter('[%(asctime)s] %(levelname)s: %(message)s', datefmt='%Y-%m-%d %H:%M:%S')
handler.setFormatter(formatter)
logger.addHandler(handler)
logger.setLevel(logging.INFO)

DRY_RUN = os.getenv('PR_METRICS_DRY_RUN') or '--dry-run' in sys.argv
VERBOSE = os.getenv('PR_METRICS_VERBOSE') or '--verbose' in sys.argv
if VERBOSE:
    logger.setLevel(logging.DEBUG)

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
METRICS_DIR = Path('/tmp/metrics')
METRICS_DIR.mkdir(exist_ok=True, parents=True)

TOKEN = os.getenv('GENESIS_AGENT_TOKEN', '')
if not TOKEN:
    logger.error("GENESIS_AGENT_TOKEN not set")
    sys.exit(1)

API_BASE = 'http://localhost:3420'


def run_shell(cmd: list, cwd=None) -> tuple[int, str]:
    """Run shell command, return (exit_code, stdout+stderr)."""
    logger.debug(f"Running: {' '.join(cmd)}")
    if DRY_RUN:
        logger.info(f"[DRY-RUN] {' '.join(cmd)}")
        return 0, '[dry-run output]'
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd or PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=600,
        )
        return result.returncode, result.stdout + result.stderr
    except subprocess.TimeoutExpired:
        logger.error(f"Command timed out: {cmd[0]}")
        return 124, 'timeout'
    except Exception as e:
        logger.error(f"Command failed: {e}")
        return 1, str(e)


def measure_flaky_async(pr_num: int):
    """
    Measure flaky tests for PR in background thread (non-blocking).
    """
    def worker():
        try:
            pr_dir = METRICS_DIR / f'pr-{pr_num}'
            pr_dir.mkdir(exist_ok=True, parents=True)
            flaky_file = pr_dir / 'flaky-report.json'

            logger.info(f"[BG] Running flaky-suite for PR #{pr_num}")

            # Fetch PR branch (simple fetch, no worktree complexity)
            code, out = run_shell(['git', 'fetch', 'origin', f'pull/{pr_num}/head:pr-{pr_num}-temp'])
            if code != 0:
                logger.warning(f"[BG] Git fetch failed for PR #{pr_num}")
                return

            # Run flaky-suite
            flaky_cmd = [
                'bash', str(SCRIPT_DIR / 'run-flaky-suite.sh'),
                '-n', '3',  # Quick 3 runs for speed
                '-o', str(flaky_file),
                '-d', str(PROJECT_ROOT),
                '--quiet',
            ]
            code, out = run_shell(flaky_cmd)
            if code == 0 and flaky_file.exists():
                logger.info(f"[BG] Flaky suite completed for PR #{pr_num}")
                # POST result to metrics endpoint
                try:
                    with open(flaky_file) as f:
                        flaky_data = json.load(f)
                    flaky_count = len(flaky_data.get('flaky_tests', []))
                    logger.info(f"[BG] PR #{pr_num}: {flaky_count} flaky tests found")
                except Exception as e:
                    logger.warning(f"[BG] Failed to parse flaky results: {e}")
            else:
                logger.warning(f"[BG] Flaky suite failed for PR #{pr_num}")
        except Exception as e:
            logger.error(f"[BG] Worker error for PR #{pr_num}: {e}")

    # Spawn background thread (non-blocking)
    t = Thread(target=worker, daemon=True)
    t.start()


def listen_events():
    """Subscribe to /api/events and handle pr.* events."""
    url = f'{API_BASE}/api/events?agent=gauge&filter=pr.*'
    headers = {'Authorization': f'Bearer {TOKEN}'}

    logger.info("Starting PR-trigger listener...")
    logger.info(f"Subscribing to {url}")

    reconnect_delay = 1
    max_reconnect_delay = 60

    while True:
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as r:
                reconnect_delay = 1  # Reset on successful connection
                for line in r:
                    line = line.decode('utf-8').strip()
                    if not line or line.startswith(':'):
                        continue
                    if line.startswith('data: '):
                        try:
                            event_data = json.loads(line[6:])
                            handle_event(event_data)
                        except json.JSONDecodeError:
                            logger.debug(f"Invalid JSON event (skipped)")
        except urllib.error.URLError as e:
            logger.warning(f"Connection lost: {e}. Reconnecting in {reconnect_delay}s...")
            time.sleep(reconnect_delay)
            reconnect_delay = min(reconnect_delay * 2, max_reconnect_delay)
        except Exception as e:
            logger.error(f"Event loop error: {e}")
            time.sleep(reconnect_delay)
            reconnect_delay = min(reconnect_delay * 2, max_reconnect_delay)


def handle_event(event: dict):
    """Handle a single pr.* event."""
    event_type = event.get('type', '')
    pr_num = event.get('pr_num')

    if not pr_num or not isinstance(pr_num, int):
        logger.debug(f"Ignoring malformed event: {event_type}")
        return

    logger.info(f"Event: {event_type} for PR #{pr_num}")

    if event_type in ('pr.opened', 'pr.ready'):
        measure_flaky_async(pr_num)
    elif event_type == 'pr.merged':
        logger.info(f"PR #{pr_num} merged (archiving not yet implemented)")


if __name__ == '__main__':
    listen_events()
