#!/usr/bin/env python3
"""Deterministic notify wrapper for the n8n false-alarm sentinel (card OPS/efb226fe).

The n8n-alert-sentinel scheduled task used to carry its Telegram-send in the
AGENT PROMPT. If the heartbeat agent did not process the task (busy, asleep,
wedged), a real finding was silently dropped -- the scheduled-task
agent-dependency silent-skip pattern.

This wrapper moves the deterministic work out of the LLM loop: run the
read-only sentinel, parse its JSON, and ONLY on ok:false with non-empty
findings send a concise Boss alert. A quiet run (the common case) stays
completely silent. Exit is ALWAYS 0 so the scheduler never treats the normal
quiet case or a transient hiccup as a failure; a sentinel error, malformed
output, or a missing token degrades to a stderr diagnostic with no send.

Guard-safe token read (mirrors scripts/noa-api.py): the env-file-print guard
rule only blocks a SHELL print-verb reading a .env file; a Python open() from a
committed script is allowed. The real bot token lives in a per-agent
native-channel .env (the root .env is empty on this host), so the token-file
chain mirrors fleet-supervisor.sh cli-version-watch: per-agent channel .env
first, root .env as a last-resort fallback. The token value is never printed.
"""
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SENTINEL = os.environ.get(
    "N8N_SENTINEL_PY", os.path.join(PROJECT_DIR, "scripts", "n8n-alert-sentinel.py")
)
CHAT_ID = os.environ.get("N8N_ALERT_CHAT_ID", "8643929442")
TELEGRAM_API_BASE = os.environ.get("N8N_TELEGRAM_API_BASE", "https://api.telegram.org")

_DEFAULT_TOKEN_FILES = ":".join(
    [
        os.path.join(PROJECT_DIR, "agents", "chad", ".claude", "channels", "telegram", ".env"),
        os.path.join(PROJECT_DIR, "agents", "dave", ".claude", "channels", "telegram", ".env"),
        os.path.join(PROJECT_DIR, ".env"),
    ]
)
TOKEN_FILES = os.environ.get("N8N_TOKEN_FILES", _DEFAULT_TOKEN_FILES)


def read_token():
    """Return the first non-empty TELEGRAM_BOT_TOKEN across the token-file chain,
    or None. Reads via open() (guard-safe); never prints the value."""
    for path in TOKEN_FILES.split(":"):
        if not path or not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith("TELEGRAM_BOT_TOKEN="):
                        token = line.split("=", 1)[1].strip()
                        if token:
                            return token
        except OSError:
            continue
    return None


def build_message(output):
    """Build the Boss alert text from a sentinel report, or None when there is
    nothing to send (ok:true, empty findings, or unparseable output)."""
    try:
        report = json.loads(output)
    except (ValueError, TypeError):
        return None
    findings = report.get("findings") or []
    if report.get("ok", True) or not findings:
        return None
    lines = ["n8n-alert-sentinel: %d finding(s)" % len(findings)]
    for item in findings:
        lines.append(
            "- [%s/%s] %s: %s"
            % (
                item.get("severity", "?"),
                item.get("class", "?"),
                item.get("workflow", "?"),
                (item.get("detail", "") or "")[:200],
            )
        )
        fix = item.get("fix")
        if fix:
            lines.append("  fix: %s" % (str(fix)[:200]))
    return "\n".join(lines)


def send(token, text):
    """POST the alert to Telegram. Raises on network/HTTP error (caller handles)."""
    data = urllib.parse.urlencode({"chat_id": CHAT_ID, "text": text}).encode()
    req = urllib.request.Request(
        "%s/bot%s/sendMessage" % (TELEGRAM_API_BASE, token), data=data, method="POST"
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


def run_sentinel():
    """Run the read-only sentinel and return its stdout, or None on failure."""
    try:
        proc = subprocess.run(
            [sys.executable, SENTINEL],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except Exception as exc:  # noqa: BLE001 -- degrade safe, never raise to scheduler
        print("n8n-alert-sentinel-notify: sentinel exec failed: %s" % exc, file=sys.stderr)
        return None
    if proc.returncode != 0 or not proc.stdout.strip():
        print(
            "n8n-alert-sentinel-notify: sentinel run failed (rc=%s, empty_output=%s)"
            % (proc.returncode, not proc.stdout.strip()),
            file=sys.stderr,
        )
        return None
    return proc.stdout


def main():
    output = run_sentinel()
    if output is None:
        return 0

    message = build_message(output)
    if not message:
        return 0  # ok:true / no findings / parse miss -> stay silent

    token = read_token()
    if not token:
        print(
            "n8n-alert-sentinel-notify: findings present but no bot token in the "
            "token-file chain; NOT delivered",
            file=sys.stderr,
        )
        return 0

    try:
        send(token, message)
    except Exception as exc:  # noqa: BLE001 -- degrade safe
        # NEVER %r/str(exc): an HTTPError/URLError stringifies the request URL,
        # which carries the bot token in the path (/bot<token>/sendMessage) ->
        # token leak to stderr (chad advisory, PR#851). Log type + HTTP status only.
        status = getattr(exc, "code", None)
        print(
            "n8n-alert-sentinel-notify: Telegram send failed: %s%s"
            % (type(exc).__name__, " (HTTP %s)" % status if status else ""),
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
