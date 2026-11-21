#!/usr/bin/env python3
"""To-Do widget freshness write-heartbeat (spec FS-AC4).

Checks each owner's most recent write to todo_items and, if it is older than the
threshold (default 36h = 129600s), emits an inter-agent "FRESHNESS ALERT" to
marveen so the fleet can investigate a wedged Claudia/Hibiki. This is the
deterministic MECHANISM; wiring it to run hourly is a deploy step:

    Genesis registers an hourly task (cron "0 * * * *") that runs:
        python3 scripts/todo-freshness-check.py

Behaviour:
  * No rows for an owner            -> skip (not a failure; matches FS no-amber edge).
  * last write <= threshold         -> ok, no alert.
  * last write >  threshold         -> alert, unless already alerted this cycle.

A small state file (default store/.todo-freshness-state.json) records the last
alert epoch per owner so the hourly run does not re-alert every hour for the same
outage ("not already flagged this cycle", FS-AC4); a fresh write clears it on the
next run. --dry-run reports what WOULD happen and never sends or writes state.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

_INSTALL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB = os.environ.get("NOA_DB_PATH", str(_INSTALL_DIR / "store" / "noa.db"))
DEFAULT_STATE = str(_INSTALL_DIR / "store" / ".todo-freshness-state.json")
DEFAULT_TOKEN = str(_INSTALL_DIR / "store" / ".dashboard-token")
# Sender identity for the inter-agent alert. This is an automated ops heartbeat,
# not a message from Dave the engineer; default to the ops/release agent so the
# alert is not mis-attributed (overridable at deploy via --from).
DEFAULT_FROM = "forge"
OWNERS = ("claudia", "hibiki")
THRESHOLD_SECONDS = 129600  # 36h (FS-AC4; widened from 26h: 24h cycle + 12h margin for outage/restart delays)
# If an agent sent a message or had a conversation_log entry within this window, it is
# considered alive even without a todo_items write (card cbaa66fa).
LIVENESS_THRESHOLD_SECONDS = 18 * 3600  # 18h -- one full daily cycle + 6h margin
# Need-aware gate (card 24e1829c): the owner's daily `todo-write-<owner>` task runs at
# 07:00. If it fired successfully within this window, the write pipeline executed (the
# agent woke and ran it); a stale todo write is then an empty valid day, not an outage.
# One daily cycle (24h) + 6h margin so a single on-time fire still counts if the monitor
# runs just before the next 07:00; a genuinely wedged scheduler (no fire > 30h) falls
# through to the liveness check and a real 'stale' alert.
WRITE_TASK_FRESH_SECONDS = 30 * 3600  # 30h
# Scheduler result token that means the task actually executed (vs 'budget-paused'/None).
WRITE_TASK_OK_RESULT = "fired"
# Suppress a repeat alert for the same ongoing outage within this window.
REALERT_SUPPRESS_SECONDS = 23 * 3600
MESSAGES_URL = "http://localhost:3420/api/messages"


def last_write_ago_seconds(conn: sqlite3.Connection, owner: str, now: int) -> int | None:
    row = conn.execute(
        "SELECT MAX(updated_at) FROM todo_items WHERE owner = ?", (owner,)
    ).fetchone()
    if row is None or row[0] is None:
        return None
    return now - int(row[0])


def last_activity_ago_seconds(conn: sqlite3.Connection, owner: str, now: int) -> int | None:
    """Return seconds since the owner's most recent outbound fleet activity.

    Only outbound evidence counts: from_agent = owner (the agent itself sent a
    message) and conversation_log (the agent's own session wrote a turn).
    Inbound traffic (to_agent = owner) is deliberately excluded: a dead agent
    still receives messages from peers that believe it is alive, so inbound
    timestamps would falsely suppress a FRESHNESS ALERT on a wedged agent.
    (Thor gate finding, PR#492.)

    Returns None when neither table has any record for this owner, or when
    the tables are absent (fresh deploy, incomplete migration -- gauge finding
    #2, card d115de7f). Callers must treat None as "no activity data", which
    leaves the stale verdict in place rather than silently suppressing it.
    """
    try:
        row = conn.execute(
            """SELECT MAX(t) FROM (
                SELECT MAX(created_at) AS t FROM agent_messages
                 WHERE from_agent = ?
                UNION ALL
                SELECT MAX(created_at) AS t FROM conversation_log
                 WHERE agent_id = ?
            )""",
            (owner, owner),
        ).fetchone()
    except sqlite3.OperationalError:
        # One or both tables are absent (fresh deploy, incomplete migration).
        # Treat as no activity data -- do NOT suppress the freshness alert.
        return None
    if row is None or row[0] is None:
        return None
    return now - int(row[0])


def write_task_fired_ago_seconds(conn: sqlite3.Connection, owner: str, now: int) -> int | None:
    """Return seconds since the owner's daily todo-write task last fired successfully.

    The write pipeline is the `todo-write-<owner>` scheduled task (daily 07:00). A recent
    successful fire is positive evidence the agent woke and executed the write, so a stale
    todo write is an empty valid day rather than an outage (card 24e1829c / OPS-343).

    Returns None -- i.e. "no proof the pipeline ran", which must NOT suppress the alert --
    when the task is absent, inactive (status != 'active'), never ran (last_run NULL), or
    last completed with a non-success result (e.g. 'budget-paused'). The task is matched by
    the stable id convention first, then by its description, so an id rename still resolves.
    """
    try:
        row = conn.execute(
            """SELECT last_run, last_result FROM scheduled_tasks
                WHERE status = 'active'
                  AND ( id = ? OR (agent = ? AND description LIKE '%To-Do widget write%') )
                ORDER BY last_run DESC
                LIMIT 1""",
            (f"todo-write-{owner}", owner),
        ).fetchone()
    except sqlite3.OperationalError:
        # scheduled_tasks table absent (fresh deploy / incomplete migration) -- no proof.
        return None
    if row is None:
        return None
    last_run, last_result = row
    if last_run is None or last_result != WRITE_TASK_OK_RESULT:
        return None
    return now - int(last_run)


def evaluate(
    conn: sqlite3.Connection,
    now: int,
    threshold: int,
    liveness_threshold: int = LIVENESS_THRESHOLD_SECONDS,
    write_task_fresh: int = WRITE_TASK_FRESH_SECONDS,
) -> list[dict]:
    """Pure evaluation: one verdict dict per owner (no IO side effects).

    States:
      ok            -- write is within threshold.
      no-rows       -- no write record at all; treated as benign (spec FS-AC4 edge).
      ok-empty-day  -- write is stale but the daily write-task fired recently; the
                       pipeline ran and had nothing to write (empty valid day). No alert.
      ok-alive      -- write is stale but agent has recent fleet activity; no alert.
      stale         -- write is stale AND no proof the pipeline ran AND no recent
                       activity; alert warranted.
    """
    out = []
    for owner in OWNERS:
        ago = last_write_ago_seconds(conn, owner, now)
        if ago is None:
            out.append({"owner": owner, "state": "no-rows", "ago": None})
        elif ago <= threshold:
            out.append({"owner": owner, "state": "ok", "ago": ago})
        else:
            # Need-aware gate: did the write pipeline actually run? A recently-fired
            # write-task means a missing write is by-design (empty day), not an outage.
            task_ago = write_task_fired_ago_seconds(conn, owner, now)
            if task_ago is not None and task_ago < write_task_fresh:
                out.append({
                    "owner": owner,
                    "state": "ok-empty-day",
                    "ago": ago,
                    "task_fired_ago": task_ago,
                })
                continue
            activity_ago = last_activity_ago_seconds(conn, owner, now)
            if activity_ago is not None and activity_ago < liveness_threshold:
                out.append({
                    "owner": owner,
                    "state": "ok-alive",
                    "ago": ago,
                    "activity_ago": activity_ago,
                })
            else:
                out.append({"owner": owner, "state": "stale", "ago": ago})
    return out


def _load_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def _alert_content(owner: str, ago: int) -> str:
    hours = ago // 3600
    # Distinguish delayed-task (36-72h) from likely-dead-agent (72h+).
    # The daily todo-write task runs at 07:00; a delay of 12h+ could be an outage
    # rather than an agent failure -- phrase the alert accordingly.
    if hours < 72:
        detail = "Daily write task appears delayed or missed. Verify the task ran and the agent is healthy."
    else:
        detail = "No write in an extended period -- agent may be down or task permanently broken."
    return (
        f"FRESHNESS ALERT: {owner} has not written to todo_items in {hours}h. {detail}"
    )


def _send_alert(content: str, token: str, sender: str = DEFAULT_FROM) -> int:
    data = json.dumps({"from": sender, "to": "marveen", "content": content}).encode()
    req = urllib.request.Request(
        MESSAGES_URL,
        data=data,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return resp.status


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description="To-Do widget freshness write-heartbeat (FS-AC4)")
    p.add_argument("--db", default=DEFAULT_DB)
    p.add_argument("--state", default=DEFAULT_STATE)
    p.add_argument("--token-file", default=DEFAULT_TOKEN)
    p.add_argument("--from", dest="sender", default=DEFAULT_FROM, help="inter-agent sender id for alerts")
    p.add_argument("--threshold", type=int, default=THRESHOLD_SECONDS)
    p.add_argument("--dry-run", action="store_true", help="report only; never send or persist state")
    p.add_argument("--now", type=int, default=None, help="override current epoch (testing)")
    args = p.parse_args(argv)

    now = args.now if args.now is not None else int(time.time())
    conn = sqlite3.connect(args.db)
    try:
        verdicts = evaluate(conn, now, args.threshold)
    finally:
        conn.close()

    state_path = Path(args.state)
    state = {} if args.dry_run else _load_state(state_path)
    sent_any = False

    for v in verdicts:
        owner, st, ago = v["owner"], v["state"], v["ago"]
        if st != "stale":
            # A healthy/empty/alive owner clears any prior alert marker.
            state.pop(owner, None)
            suffix = f" (ago={ago}s" if ago is not None else ""
            if st == "ok-alive" and "activity_ago" in v:
                suffix += f", last_activity={v['activity_ago']}s"
            if st == "ok-empty-day" and "task_fired_ago" in v:
                suffix += f", write_task_fired={v['task_fired_ago']}s ago"
            if suffix:
                suffix += ")"
            print(f"[{owner}] {st}{suffix}")
            continue

        last_alert = state.get(owner, 0)
        suppressed = (now - last_alert) < REALERT_SUPPRESS_SECONDS
        content = _alert_content(owner, ago)
        if args.dry_run:
            print(f"[{owner}] STALE ago={ago}s -> WOULD ALERT: {content}")
            continue
        if suppressed:
            print(f"[{owner}] STALE ago={ago}s -> suppressed (alerted {now - last_alert}s ago)")
            continue
        try:
            token = Path(args.token_file).read_text().strip()
            status = _send_alert(content, token, args.sender)
            state[owner] = now
            sent_any = True
            print(f"[{owner}] STALE ago={ago}s -> ALERT sent (HTTP {status})")
        except Exception as err:  # noqa: BLE001 - heartbeat must never crash the cron
            print(f"[{owner}] STALE ago={ago}s -> alert send FAILED: {err}", file=sys.stderr)

    if not args.dry_run:
        try:
            state_path.write_text(json.dumps(state))
        except OSError as err:
            print(f"warning: could not persist state: {err}", file=sys.stderr)

    return 0 if not sent_any else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
