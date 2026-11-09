#!/usr/bin/env python3
"""
wake-on-dm-daemon.py -- Poll sleeping channel-agent bots for Boss DMs.

When a channel agent is sleeping (no tmux session), this daemon short-polls
that bot's Telegram getUpdates WITHOUT advancing the offset (peek mode).
When a Boss DM arrives, it calls wake-channel-agent.sh to start the agent.
Once the agent is awake (tmux session visible), polling stops for that bot
(avoids 409 conflict with the agent's own plugin long-poll).

Security invariants:
  - Token NEVER written to log, NEVER in URL-form in log output.
  - Log only: agent name, check results, wake events (no token shape).
  - Read token once from .env file per agent, kept in memory only.
  - Update offset is NEVER called (peek-only, agent plugin gets the DM).

Fleet integration:
  - Managed by wake-on-dm-watchdog.sh (pgrep pattern: wake-on-dm-daemon.py)
  - For full fleet: fleet-supervisor calls ensure_wake_on_dm_daemon() after
    chad-pass + pilot success (PR required).
"""

import os
import re
import sys
import time
import signal
import logging
import subprocess
import urllib.request
import urllib.error
import json

INSTALL_DIR   = "/home/domin/marveen"
LOG_FILE      = f"{INSTALL_DIR}/store/wake-on-dm.log"
WAKE_SCRIPT   = f"{INSTALL_DIR}/scripts/wake-channel-agent.sh"
AGENTS_DIR    = f"{INSTALL_DIR}/agents"
POLL_INTERVAL = 5       # seconds between short-polls per sleeping agent
BOSS_CHAT_ID  = 8643929442
POLL_TIMEOUT  = 0       # timeout=0 = short-poll (returns immediately, no ack)

# Pilot: buster only. For full fleet, expand after chad-pass + 6-measure green.
# Loaded from sleep-eligible.txt if present (agents that can sleep).
PILOT_AGENTS  = ["buster"]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [wake-on-dm] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(sys.stderr),
    ],
)
log = logging.getLogger(__name__)

# Graceful shutdown
_shutdown = False
def _sig(signum, frame):
    global _shutdown
    _shutdown = True
    log.info("shutdown signal received")
signal.signal(signal.SIGTERM, _sig)
signal.signal(signal.SIGINT,  _sig)


def load_token(agent_name: str) -> str | None:
    """Read bot token from agent .env. Returns None on error. NEVER logs value."""
    env_path = os.path.join(AGENTS_DIR, agent_name, ".claude", "channels", "telegram", ".env")
    try:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("TELEGRAM_BOT_TOKEN="):
                    val = line.split("=", 1)[1].strip().strip("\"'")
                    if re.match(r"^\d+:[A-Za-z0-9_-]{30,}$", val):
                        return val
    except Exception as e:
        log.warning("agent=%s token read failed: %s", agent_name, e)
    return None


def is_agent_alive(agent_name: str) -> bool:
    """True if the agent's tmux session exists."""
    result = subprocess.run(
        ["tmux", "has-session", "-t", f"=agent-{agent_name}"],
        capture_output=True, timeout=5
    )
    return result.returncode == 0


def peek_updates(token: str) -> list:
    """
    getUpdates with NO offset (peek, not consume) and timeout=0.
    Returns list of update dicts, or [] on error.
    NEVER logs the token or the full URL.
    """
    url = (
        f"https://api.telegram.org/bot{token}"
        f"/getUpdates?limit=10&allowed_updates=%5B%22message%22%5D&timeout={POLL_TIMEOUT}"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "fleet-wake-daemon/1.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
            if data.get("ok"):
                return data.get("result", [])
    except urllib.error.HTTPError as e:
        if e.code == 409:
            # 409 = another getUpdates is running (agent woke up and plugin started)
            log.info("peek: 409 conflict -- agent plugin is polling, stopping our peek")
        else:
            log.warning("peek: HTTP %s", e.code)
    except Exception as e:
        log.warning("peek: error %s", type(e).__name__)
    return []


def has_boss_dm(updates: list) -> bool:
    """True if any update is a private message from Boss (BOSS_CHAT_ID).
    If BOSS_CHAT_ID==0, any private message triggers (pre-validation mode)."""
    for u in updates:
        msg = u.get("message", {})
        chat = msg.get("chat", {})
        if chat.get("type") == "private" and (BOSS_CHAT_ID == 0 or chat.get("id") == BOSS_CHAT_ID):
            return True
    return False


def run_wake(agent_name: str) -> bool:
    """Call wake-channel-agent.sh. Returns True on success (exit 0 or 2=already alive)."""
    try:
        result = subprocess.run(
            ["bash", WAKE_SCRIPT, agent_name],
            capture_output=True, text=True, timeout=30
        )
        # exit 0 = woke or NOOP-alive, exit 1 = rejected, exit 2 = watchdog missing
        if result.returncode in (0, 2):
            log.info("wake: agent=%s exit=%d", agent_name, result.returncode)
            return True
        log.warning("wake: agent=%s exit=%d stderr=%s",
                    agent_name, result.returncode, result.stderr.strip()[:200])
        return False
    except Exception as e:
        log.error("wake: agent=%s error=%s", agent_name, e)
        return False


def load_eligible_agents() -> list[str]:
    """
    Returns agents to monitor. For pilot: PILOT_AGENTS only.
    Full fleet: read sleep-eligible.txt and intersect with channel-agent allowlist.
    """
    return list(PILOT_AGENTS)


def main():
    log.info("wake-on-dm-daemon started (pilot_agents=%s poll_interval=%ds)",
             PILOT_AGENTS, POLL_INTERVAL)

    # Per-agent state: last_woken timestamp to avoid rapid re-wake
    last_woken: dict[str, float] = {}
    # Cooldown after waking: don't re-wake within 60s
    WAKE_COOLDOWN = 60.0

    while not _shutdown:
        agents = load_eligible_agents()

        for agent_name in agents:
            if _shutdown:
                break

            alive = is_agent_alive(agent_name)
            if alive:
                # Agent is up -- no polling needed, plugin has long-poll
                continue

            # Agent is sleeping -- peek for Boss DM
            token = load_token(agent_name)
            if not token:
                log.warning("agent=%s no bot token found, skipping", agent_name)
                continue

            updates = peek_updates(token)

            if not updates:
                continue

            if has_boss_dm(updates):
                # Check cooldown
                now = time.time()
                if now - last_woken.get(agent_name, 0.0) < WAKE_COOLDOWN:
                    log.info("agent=%s Boss DM seen but in wake cooldown, skipping", agent_name)
                    continue

                log.info("agent=%s Boss DM detected, waking", agent_name)
                ok = run_wake(agent_name)
                if ok:
                    last_woken[agent_name] = now
            else:
                log.info("agent=%s sleeping, %d update(s), no Boss DM", agent_name, len(updates))

        if not _shutdown:
            time.sleep(POLL_INTERVAL)

    log.info("wake-on-dm-daemon exiting cleanly")


if __name__ == "__main__":
    main()
