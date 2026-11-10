#!/usr/bin/env python3
"""Minimal curator CLI for the topic_status table (card eaa623a9).

Usage:
  topic-status-write.py <agent_id> close "<topic>" "<source_ref>"
  topic-status-write.py <agent_id> open  "<topic>" "<blocker>"
  topic-status-write.py <agent_id> done  <id>
  topic-status-write.py <agent_id> list

Environment:
  TOPIC_STATUS_DB  override DB path (default: auto-detect noa.db next to scripts/)
"""
import os
import sqlite3
import sys
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS topic_status (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id   TEXT NOT NULL,
    status     TEXT NOT NULL CHECK(status IN ('closed','open')),
    topic      TEXT NOT NULL,
    source_ref TEXT,
    blocker    TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
)
"""
INDEX = (
    "CREATE INDEX IF NOT EXISTS idx_ts_agent ON topic_status(agent_id, status, updated_at)"
)


def _db_path() -> str:
    override = os.environ.get("TOPIC_STATUS_DB")
    if override:
        return override
    here = Path(__file__).parent
    install = here.parent
    env_file = install / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("NOA_DB_PATH="):
                val = line.split("=", 1)[1].strip()
                if os.path.isabs(val):
                    return val
                return str(install / val)
    return str(install / "store" / "noa.db")


def _connect(path: str) -> sqlite3.Connection:
    con = sqlite3.connect(path, timeout=10)
    con.execute(SCHEMA)
    con.execute(INDEX)
    con.commit()
    return con


def cmd_close(con: sqlite3.Connection, agent_id: str, topic: str, source_ref: str) -> None:
    now = int(time.time())
    con.execute(
        "INSERT INTO topic_status(agent_id,status,topic,source_ref,created_at,updated_at)"
        " VALUES (?,?,?,?,?,?)",
        (agent_id, "closed", topic, source_ref, now, now),
    )
    con.commit()
    print(f"closed: {topic!r} (source: {source_ref})")


def cmd_open(con: sqlite3.Connection, agent_id: str, topic: str, blocker: str) -> None:
    now = int(time.time())
    con.execute(
        "INSERT INTO topic_status(agent_id,status,topic,blocker,created_at,updated_at)"
        " VALUES (?,?,?,?,?,?)",
        (agent_id, "open", topic, blocker, now, now),
    )
    con.commit()
    print(f"open: {topic!r} (blocker: {blocker})")


def cmd_done(con: sqlite3.Connection, agent_id: str, row_id: str) -> None:
    cur = con.execute(
        "DELETE FROM topic_status WHERE id=? AND agent_id=?", (int(row_id), agent_id)
    )
    con.commit()
    if cur.rowcount:
        print(f"removed row {row_id}")
    else:
        print(f"row {row_id} not found for agent {agent_id}", file=sys.stderr)
        sys.exit(1)


def cmd_list(con: sqlite3.Connection, agent_id: str) -> None:
    rows = con.execute(
        "SELECT id, status, topic, source_ref, blocker, updated_at"
        " FROM topic_status WHERE agent_id=? ORDER BY updated_at ASC",
        (agent_id,),
    ).fetchall()
    if not rows:
        print("(no entries)")
        return
    for row_id, status, topic, source_ref, blocker, ts in rows:
        ref = source_ref or blocker or ""
        print(f"[{row_id}] {status.upper():7s} {topic}  ({ref})")


def main(argv: list) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    agent_id = argv[0]
    subcmd = argv[1]
    path = _db_path()
    try:
        con = _connect(path)
    except Exception as exc:
        print(f"Cannot open DB {path}: {exc}", file=sys.stderr)
        return 1

    try:
        if subcmd == "close":
            if len(argv) < 4:
                print("Usage: close <topic> <source_ref>", file=sys.stderr)
                return 2
            cmd_close(con, agent_id, argv[2], argv[3])
        elif subcmd == "open":
            if len(argv) < 4:
                print("Usage: open <topic> <blocker>", file=sys.stderr)
                return 2
            cmd_open(con, agent_id, argv[2], argv[3])
        elif subcmd == "done":
            if len(argv) < 3:
                print("Usage: done <id>", file=sys.stderr)
                return 2
            cmd_done(con, agent_id, argv[2])
        elif subcmd == "list":
            cmd_list(con, agent_id)
        else:
            print(f"Unknown subcommand: {subcmd!r}. Use close|open|done|list.", file=sys.stderr)
            return 2
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
