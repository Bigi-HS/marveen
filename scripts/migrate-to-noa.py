#!/usr/bin/env python3
"""Migrate claudeclaw.db -> noa.db for the NoA A1 data-layer redesign.

Card f68461a6 / block A1. Spec: store/spec-noa-a1-db-schema.md (v4, Thor PASS).

Design (CONTINUITY-FIRST):
  * The source (claudeclaw.db) is opened READ-ONLY (mode=ro + PRAGMA query_only)
    and is NEVER written. The live fleet keeps running on it (AC-3d, STRIDE T1).
  * The target is built from scratch into a temp file, verified for row-count
    parity, then atomically renamed into place. This makes the migration
    IDEMPOTENT in the strongest sense -- a re-run against the same source yields
    the same noa.db, with no duplicate-insert and no partial/corrupt state
    (AC-3a, STRIDE T2). It also makes a failed run leave the previous noa.db
    untouched.
  * Redesigned tables (memories, agent_messages, sessions, scheduled_tasks) get
    explicit column-mapping transforms; every other table is copied verbatim.

Usage:
  python3 scripts/migrate-to-noa.py [--source store/claudeclaw.db] [--target store/noa.db]
Exits non-zero if any row-count parity check fails or a FK violation is found.
"""
import argparse
import base64
import json
import os
import sqlite3
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_PATH = os.path.join(HERE, "schema-noa.sql")

# Tables with a custom transform (everything else is copied verbatim).
REDESIGNED = {"memories", "agent_messages", "sessions", "scheduled_tasks"}
# Source-only tables that are never migrated as base tables.
SKIP = {"sqlite_sequence"}

PRIORITY_MAP = {"urgent": 100, "high": 75, "normal": 50, "low": 25}
DEFAULT_PRIORITY = 50
DEFAULT_AGENT = "marveen"
BATCH = 1000  # rows per insert transaction (OQ-3)

warnings = []


def warn(msg):
    warnings.append(msg)
    print(f"WARN: {msg}", file=sys.stderr)


def embedding_to_blob(value, row_id):
    """Legacy embedding (JSON text | base64 | other) -> little-endian float32 BLOB.

    Priority order (AC-3c M2, authoritative over Section 6 prose):
      1. JSON array  -> json.loads + struct.pack('<Nf', *v)
      2. base64      -> base64.b64decode (already packed float32 bytes)
      3. otherwise   -> NULL + WARN (never silently truncate/zero)
    """
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)  # already binary
    s = str(value).strip()
    if not s:
        return None
    # 1. JSON array of numbers
    if s[0] == "[":
        try:
            arr = json.loads(s)
            if isinstance(arr, list) and all(isinstance(x, (int, float)) for x in arr) and arr:
                return struct.pack(f"<{len(arr)}f", *(float(x) for x in arr))
        except (ValueError, struct.error):
            pass
    # 2. base64-encoded float32 bytes
    try:
        raw = base64.b64decode(s, validate=True)
        if raw and len(raw) % 4 == 0:
            return raw
    except (ValueError, base64.binascii.Error):
        pass
    # 3. unconvertible
    warn(f"embedding row {row_id} unconvertible -> NULL")
    return None


def map_priority(value):
    if value is None:
        return DEFAULT_PRIORITY
    if isinstance(value, int):
        return value
    return PRIORITY_MAP.get(str(value).strip().lower(), DEFAULT_PRIORITY)


def table_columns(conn, table):
    return [r[1] for r in conn.execute(f"PRAGMA table_info('{table}')")]


def source_tables(src):
    return {
        r[0]
        for r in src.execute("SELECT name FROM sqlite_master WHERE type='table'")
        if not r[0].startswith("memories_fts") and r[0] not in SKIP
    }


def chunked(rows, n):
    for i in range(0, len(rows), n):
        yield rows[i : i + n]


def build_chat_to_agent(src, src_tabs):
    """OQ-1: chat_id -> agent_id from conversation_log, when unambiguous."""
    mapping = {}
    if "conversation_log" not in src_tabs:
        return mapping
    rows = src.execute(
        "SELECT chat_id, agent_id, COUNT(DISTINCT agent_id) AS n "
        "FROM conversation_log GROUP BY chat_id"
    ).fetchall()
    for chat_id, agent_id, n in rows:
        if n == 1 and agent_id:
            mapping[str(chat_id)] = agent_id
    return mapping


def migrate_memories(src, dst):
    cols = table_columns(src, "memories")
    out = []
    for row in src.execute("SELECT * FROM memories"):
        r = dict(zip(cols, row))
        out.append(
            (
                r["id"],
                r.get("agent_id") or DEFAULT_AGENT,
                r.get("category") or "general",
                r.get("content") if r.get("content") is not None else "",
                r.get("keywords"),
                r.get("topic_key"),
                r.get("access_scope"),
                embedding_to_blob(r.get("embedding"), r["id"]),
                r.get("created_at") if r.get("created_at") is not None else 0,
                r.get("accessed_at") if r.get("accessed_at") is not None else 0,
            )
        )
        if not (r.get("agent_id")):
            warn(f"memory {r['id']} agent_id defaulted to {DEFAULT_AGENT}")
    sql = (
        "INSERT INTO memories (id, agent_id, category, content, keywords, topic_key, "
        "access_scope, embedding, created_at, accessed_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    )
    for batch in chunked(out, BATCH):
        dst.executemany(sql, batch)


def migrate_agent_messages(src, dst):
    cols = table_columns(src, "agent_messages")
    out = []
    for row in src.execute("SELECT * FROM agent_messages"):
        r = dict(zip(cols, row))
        out.append(
            (
                r["id"], r.get("from_agent"), r.get("to_agent"), r.get("content"),
                r.get("status"), map_priority(r.get("priority")), r.get("in_reply_to"),
                r.get("ack_expected") or 0, r.get("result"), r.get("created_at"),
                r.get("delivered_at"), r.get("completed_at"), r.get("last_escalated_at"),
            )
        )
    sql = (
        "INSERT INTO agent_messages (id, from_agent, to_agent, content, status, priority, "
        "in_reply_to, ack_expected, result, created_at, delivered_at, completed_at, "
        "last_escalated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    for batch in chunked(out, BATCH):
        dst.executemany(sql, batch)


def migrate_sessions(src, dst, chat_to_agent):
    cols = table_columns(src, "sessions")
    out = []
    for row in src.execute("SELECT * FROM sessions"):
        r = dict(zip(cols, row))
        chat_id = str(r.get("chat_id"))
        agent_id = chat_to_agent.get(chat_id)
        if not agent_id:
            agent_id = DEFAULT_AGENT
            warn(f"session {r.get('session_id')} (chat_id={chat_id}) agent defaulted to {DEFAULT_AGENT} -- REVIEW")
        out.append(
            (agent_id, r.get("session_id"), r.get("updated_at") or 0, r.get("message_count") or 0)
        )
    sql = "INSERT INTO sessions (agent_id, session_id, updated_at, message_count) VALUES (?,?,?,?)"
    for batch in chunked(out, BATCH):
        dst.executemany(sql, batch)


def migrate_scheduled_tasks(src, dst):
    cols = table_columns(src, "scheduled_tasks")
    has_agent = "agent" in cols
    has_type = "type" in cols
    has_desc = "description" in cols
    out = []
    for row in src.execute("SELECT * FROM scheduled_tasks"):
        r = dict(zip(cols, row))
        agent = (r.get("agent") if has_agent else None) or DEFAULT_AGENT
        if not (has_agent and r.get("agent")):
            warn(f"task {r.get('id')} agent defaulted to {DEFAULT_AGENT}")
        ttype = (r.get("type") if has_type else None) or "task"
        desc = r.get("description") if has_desc else None
        out.append(
            (
                r.get("id"), agent, ttype, desc, r.get("prompt"), r.get("schedule"),
                r.get("next_run") if r.get("next_run") is not None else 0,
                r.get("last_run"), r.get("last_result"), r.get("status") or "active",
                r.get("created_at") if r.get("created_at") is not None else 0,
            )
        )
    sql = (
        "INSERT INTO scheduled_tasks (id, agent, type, description, prompt, schedule, "
        "next_run, last_run, last_result, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    )
    for batch in chunked(out, BATCH):
        dst.executemany(sql, batch)


def migrate_verbatim(src, dst, table):
    tcols = table_columns(dst, table)
    scols = set(table_columns(src, table))
    cols = [c for c in tcols if c in scols]
    if not cols:
        return
    collist = ", ".join(cols)
    placeholders = ", ".join("?" for _ in cols)
    rows = src.execute(f"SELECT {collist} FROM {table}").fetchall()
    sql = f"INSERT INTO {table} ({collist}) VALUES ({placeholders})"
    for batch in chunked(rows, BATCH):
        dst.executemany(sql, batch)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="store/claudeclaw.db")
    ap.add_argument("--target", default="store/noa.db")
    args = ap.parse_args()

    if not os.path.exists(args.source):
        print(f"ERROR: source DB not found: {args.source}", file=sys.stderr)
        sys.exit(2)

    tmp = args.target + ".tmp"
    for sidecar in (tmp, tmp + "-wal", tmp + "-shm"):
        if os.path.exists(sidecar):
            os.remove(sidecar)
    if os.path.exists(args.target):
        print(f"INFO: {args.target} exists, rebuilding atomically (idempotent)")

    # Source: strictly read-only.
    src = sqlite3.connect(f"file:{args.source}?mode=ro", uri=True)
    src.execute("PRAGMA query_only = ON")
    src_tabs = source_tables(src)

    dst = sqlite3.connect(tmp)
    dst.execute("PRAGMA foreign_keys = OFF")  # load order independent; verified after
    dst.executescript(open(SCHEMA_PATH).read())

    chat_to_agent = build_chat_to_agent(src, src_tabs)

    target_tabs = [
        r[0]
        for r in dst.execute("SELECT name FROM sqlite_master WHERE type='table'")
        if not r[0].startswith("memories_fts") and r[0] not in SKIP
    ]

    dst.execute("BEGIN")
    if "memories" in src_tabs:
        migrate_memories(src, dst)
    if "agent_messages" in src_tabs:
        migrate_agent_messages(src, dst)
    if "sessions" in src_tabs:
        migrate_sessions(src, dst, chat_to_agent)
    if "scheduled_tasks" in src_tabs:
        migrate_scheduled_tasks(src, dst)
    for t in target_tabs:
        if t in REDESIGNED or t == "embedding_cache":
            continue
        if t in src_tabs:
            migrate_verbatim(src, dst, t)
    # FTS5 rebuild from migrated memories content (AC-3e)
    dst.execute("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')")
    dst.execute("COMMIT")

    # FK integrity (loaded with FK off; verify now)
    fk_violations = dst.execute("PRAGMA foreign_key_check").fetchall()
    if fk_violations:
        print(f"ERROR: foreign key violations: {fk_violations}", file=sys.stderr)
        dst.close(); src.close(); os.remove(tmp)
        sys.exit(1)

    # Row-count parity (AC-3b): every migrated table that exists in source.
    print("Row-count parity (source -> target):")
    mismatches = []
    for t in target_tabs:
        if t not in src_tabs:
            continue
        sc = src.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        nc = dst.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        flag = "OK" if sc == nc else "MISMATCH"
        if sc != nc:
            mismatches.append(t)
        print(f"  {flag:8} {t}: {sc} -> {nc}")
    # FTS sanity
    fc = dst.execute("SELECT COUNT(*) FROM memories_fts").fetchone()[0]
    mc = dst.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
    print(f"  {'OK' if fc == mc else 'MISMATCH':8} memories_fts: {mc} -> {fc}")
    if fc != mc:
        mismatches.append("memories_fts")

    dst.commit()
    dst.close()
    src.close()

    if mismatches:
        print(f"ERROR: parity mismatch in: {mismatches}", file=sys.stderr)
        os.remove(tmp)
        sys.exit(1)

    # Atomic swap into place, then enable WAL on the final-named file (AC-5).
    os.chmod(tmp, 0o600)
    os.replace(tmp, args.target)
    final = sqlite3.connect(args.target)
    final.execute("PRAGMA journal_mode = WAL")
    final.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    final.close()
    os.chmod(args.target, 0o600)
    for sidecar in (args.target + "-wal", args.target + "-shm"):
        if os.path.exists(sidecar):
            os.chmod(sidecar, 0o600)

    print(f"OK: migrated {args.source} -> {args.target} ({len(warnings)} warnings)")
    sys.exit(0)


if __name__ == "__main__":
    main()
