#!/usr/bin/env python3
"""TDD harness for the NoA A1 DB-schema migration (card f68461a6 / A1).

Hermetic: builds a synthetic claudeclaw-like source DB covering the migration
edge cases, runs schema-noa.sql + migrate-to-noa.py + parity-check.py against
it, and asserts every mandatory TDD point from the spec:

  - schema applies to a blank DB (AC-1, >=22 tables)
  - core column contract (AC-2): no legacy cols; sessions composite PK;
    agent_messages.priority INTEGER
  - >=12 idx_* indexes present (AC-4)
  - FTS5 trigram vtable + triggers; rebuilt count == memories count (AC-6)
  - embedding is BLOB, little-endian float32 round-trips (AC-7); JSON-first,
    base64 fallback, unconvertible -> NULL (AC-3c M2)
  - row-count parity per migrated table (AC-3b)
  - priority TEXT->INTEGER mapping (AC-3c / OQ-4)
  - sessions chat_id -> agent_id (conversation_log map, else 'marveen') (OQ-1)
  - idempotent re-run: byte-stable row counts, no duplicate-insert (AC-3a)
  - source DB untouched / read-only (AC-3d)
  - noa.db perms 0600 (STRIDE I2)
  - parity-check.py exits 0 / prints PASS (AC-10)

Run: python3 scripts/test-noa-migration.py
Exit 0 = all green; non-zero = a failing assertion (the test name is printed).
"""
import base64
import json
import os
import sqlite3
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATE = os.path.join(HERE, "migrate-to-noa.py")
PARITY = os.path.join(HERE, "parity-check.py")
SCHEMA = os.path.join(HERE, "schema-noa.sql")

PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}")


def build_synthetic_source(path):
    """A minimal claudeclaw.db: legacy redesigned tables + a few carried ones."""
    conn = sqlite3.connect(path)
    c = conn.cursor()
    # --- legacy memories (with chat_id/sector/salience/auto_generated, embedding TEXT)
    c.executescript(
        """
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, topic_key TEXT,
          content TEXT, sector TEXT, salience REAL, created_at INTEGER,
          accessed_at INTEGER, agent_id TEXT, category TEXT,
          auto_generated INTEGER, keywords TEXT, embedding TEXT, access_scope TEXT
        );
        CREATE TABLE sessions (
          chat_id TEXT PRIMARY KEY, session_id TEXT, updated_at INTEGER,
          message_count INTEGER
        );
        CREATE TABLE conversation_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
          chat_id TEXT NOT NULL, direction TEXT, message_id TEXT, text TEXT,
          ts TEXT, created_at INTEGER NOT NULL
        );
        CREATE TABLE scheduled_tasks (
          id TEXT PRIMARY KEY, chat_id TEXT, prompt TEXT, schedule TEXT,
          next_run INTEGER, last_run INTEGER, last_result TEXT, status TEXT,
          created_at INTEGER
        );
        CREATE TABLE agent_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent TEXT, to_agent TEXT,
          content TEXT, status TEXT, result TEXT, created_at INTEGER,
          delivered_at INTEGER, completed_at INTEGER, ack_expected INTEGER,
          priority TEXT, in_reply_to INTEGER, last_escalated_at INTEGER
        );
        CREATE TABLE kanban_cards (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
          status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','waiting','done','someday')),
          assignee TEXT, priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
          project TEXT, parent_id TEXT, due_date INTEGER, sort_order REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER, dispatched_at INTEGER
        );
        CREATE TABLE token_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, session_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0, content_preview TEXT, tool_name TEXT,
          task_title TEXT, project TEXT, model TEXT, spawned_by TEXT
        );
        CREATE TABLE daily_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, date TEXT NOT NULL,
          content TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE idea_box (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
          category TEXT NOT NULL DEFAULT 'Egyeb', status TEXT NOT NULL DEFAULT 'new',
          source TEXT NOT NULL DEFAULT 'marveen', kanban_id TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, impact INTEGER, effort INTEGER
        );
        """
    )
    # memories rows: JSON embedding, base64 embedding, NULL, garbage, NULL agent_id
    vec = [0.5, -1.25, 3.0, -0.0625]
    json_emb = json.dumps(vec)
    b64_emb = base64.b64encode(struct.pack(f"<{len(vec)}f", *vec)).decode()
    rows = [
        # id, chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords, embedding, access_scope
        (1, "123", "tk1", "kanban delivery note", "s", 0.9, 1000, 1000, "dave", "hot", 0, "kanban delivery", json_emb, None),
        (2, "123", None, "second memory base64", "s", 0.1, 1001, 1001, "thor", "warm", 1, "test", b64_emb, None),
        (3, None, None, "third memory no embedding", None, None, 1002, 1002, "marveen", "cold", 0, "noemb", None, None),
        (4, None, None, "garbage embedding row", None, None, 1003, 1003, "scout", "shared", 0, "garb", "not-a-vector!!!", None),
        (5, None, None, "null agent default", None, None, 1004, 1004, None, None, 0, None, None, None),
    ]
    c.executemany("INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    # conversation_log: maps chat_id 123 -> claudia
    c.execute("INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at) VALUES ('claudia','123','in','m1','hi','t',1000)")
    # sessions: 123 mappable -> claudia; 999 unmappable -> marveen default
    c.executemany("INSERT INTO sessions VALUES (?,?,?,?)", [("123", "sess-a", 2000, 5), ("999", "sess-b", 2001, 3)])
    # scheduled_tasks: one row, no agent/type in legacy
    c.execute("INSERT INTO scheduled_tasks VALUES ('daily-x','123','do x','0 9 * * *',3000,None_,'ok','active',2999)".replace("None_", "NULL"))
    # agent_messages: each priority + unknown
    msgs = [
        (1, "dave", "thor", "urgent msg", "pending", None, 100, None, None, 0, "urgent", None, None),
        (2, "dave", "thor", "high msg", "delivered", None, 101, 102, None, 0, "high", None, None),
        (3, "dave", "thor", "normal msg", "completed", "ok", 102, 103, 104, 0, "normal", None, None),
        (4, "dave", "thor", "low msg", "pending", None, 103, None, None, 0, "low", None, None),
        (5, "dave", "thor", "weird msg", "pending", None, 104, None, None, 0, "bizarre", None, None),
    ]
    c.executemany("INSERT INTO agent_messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", msgs)
    # kanban: includes a 'someday' status (must survive verbatim)
    c.executemany(
        "INSERT INTO kanban_cards (id,title,description,status,assignee,priority,project,parent_id,due_date,sort_order,created_at,updated_at,archived_at,dispatched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            ("c1", "Card one", "d", "in_progress", "dave", "high", "noa", None, None, 1.0, 5000, 5001, None, None),
            ("c2", "Someday card", "d", "someday", None, "low", None, None, None, 2.0, 5002, 5003, None, None),
        ],
    )
    c.execute("INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,model) VALUES ('dave','s1',6000,10,20,5,3,'opus')")
    c.execute("INSERT INTO daily_logs (agent_id,date,content,created_at) VALUES ('dave','2026-06-24','log',7000)")
    c.execute("INSERT INTO idea_box (id,title,description,category,status,source,created_at,updated_at) VALUES ('i1','idea','d','Egyeb','new','marveen',8000,8001)")
    conn.commit()
    conn.close()


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def main():
    if not os.path.exists(MIGRATE) or not os.path.exists(SCHEMA) or not os.path.exists(PARITY):
        print("RED: migration artifacts not yet implemented (expected during TDD red phase)")
        print(f"  schema-noa.sql exists: {os.path.exists(SCHEMA)}")
        print(f"  migrate-to-noa.py exists: {os.path.exists(MIGRATE)}")
        print(f"  parity-check.py exists: {os.path.exists(PARITY)}")
        sys.exit(1)

    tmp = tempfile.mkdtemp(prefix="noa-test-")
    src = os.path.join(tmp, "claudeclaw.db")
    dst = os.path.join(tmp, "noa.db")
    build_synthetic_source(src)
    src_mtime_before = os.path.getmtime(src)

    # --- AC-1: schema applies to blank DB, >=22 tables
    blank = sqlite3.connect(":memory:")
    blank.executescript(open(SCHEMA).read())
    tabs = [r[0] for r in blank.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    check("AC-1 schema applies, >=22 tables", len(tabs) >= 22)
    # AC-2 column contract on the blank schema
    mcols = [r[1] for r in blank.execute("PRAGMA table_info('memories')")]
    check("AC-2a no legacy memories cols", not (set(mcols) & {"chat_id", "sector", "salience", "auto_generated"}))
    spk = [r[1] for r in blank.execute("PRAGMA table_info('sessions')") if r[5] > 0]
    check("AC-2b sessions composite PK (agent_id, session_id)", set(spk) == {"agent_id", "session_id"})
    sched = {r[1]: r for r in blank.execute("PRAGMA table_info('scheduled_tasks')")}
    check("AC-2c scheduled_tasks has agent + type, no chat_id", "agent" in sched and "type" in sched and "chat_id" not in sched)
    amcols = {r[1]: r[2] for r in blank.execute("PRAGMA table_info('agent_messages')")}
    check("AC-2d agent_messages.priority INTEGER", amcols.get("priority", "").upper() == "INTEGER")
    embtype = {r[1]: r[2] for r in blank.execute("PRAGMA table_info('memories')")}.get("embedding", "")
    check("AC-7a memories.embedding is BLOB", embtype.upper() == "BLOB")
    cachetype = {r[1]: r[2] for r in blank.execute("PRAGMA table_info('embedding_cache')")}.get("embedding", "")
    check("AC-7c embedding_cache.embedding is BLOB", cachetype.upper() == "BLOB")
    idxs = [r[0] for r in blank.execute("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")]
    check("AC-4 >=12 idx_ indexes", len(idxs) >= 12)
    ftss = [r[0] for r in blank.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'")]
    check("AC-6 memories_fts present", len(ftss) == 1)
    trigs = [r[0] for r in blank.execute("SELECT name FROM sqlite_master WHERE type='trigger'")]
    check("AC-6c FTS triggers present (>=3)", len(trigs) >= 3)
    blank.close()

    # --- run the migration
    r = run(["python3", MIGRATE, "--source", src, "--target", dst])
    check("migrate exits 0", r.returncode == 0)
    if r.returncode != 0:
        print("migrate stderr:\n" + r.stderr)
        print("migrate stdout:\n" + r.stdout)

    if os.path.exists(dst):
        nconn = sqlite3.connect(dst)
        # row-count parity for the migrated core tables
        sconn = sqlite3.connect(src)
        for t in ["memories", "agent_messages", "sessions", "scheduled_tasks", "kanban_cards", "token_usage", "daily_logs", "idea_box"]:
            sc = sconn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            nc = nconn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            check(f"AC-3b parity {t} ({sc}=={nc})", sc == nc)
        sconn.close()
        # AC-2d at data level: priority is INTEGER mapped
        prio = dict(nconn.execute("SELECT id, priority FROM agent_messages").fetchall())
        check("OQ-4 priority urgent->100", prio.get(1) == 100)
        check("OQ-4 priority high->75", prio.get(2) == 75)
        check("OQ-4 priority normal->50", prio.get(3) == 50)
        check("OQ-4 priority low->25", prio.get(4) == 25)
        check("OQ-4 priority unknown->50", prio.get(5) == 50)
        check("priority column type INTEGER at runtime", all(isinstance(v, int) for v in prio.values()))
        # AC-7b embedding BLOB + little-endian round-trip
        emb1 = nconn.execute("SELECT embedding FROM memories WHERE id=1").fetchone()[0]
        check("AC-7 embedding stored as bytes (BLOB)", isinstance(emb1, (bytes, bytearray)))
        if isinstance(emb1, (bytes, bytearray)):
            unpacked = list(struct.unpack(f"<{len(emb1)//4}f", emb1))
            check("AC-3c M2 JSON embedding little-endian round-trip", unpacked == [0.5, -1.25, 3.0, -0.0625])
        emb2 = nconn.execute("SELECT embedding FROM memories WHERE id=2").fetchone()[0]
        check("AC-3c M2 base64 embedding decoded to BLOB", isinstance(emb2, (bytes, bytearray)) and list(struct.unpack(f"<{len(emb2)//4}f", emb2)) == [0.5, -1.25, 3.0, -0.0625])
        emb3 = nconn.execute("SELECT embedding FROM memories WHERE id=3").fetchone()[0]
        check("AC-3c null embedding stays NULL", emb3 is None)
        emb4 = nconn.execute("SELECT embedding FROM memories WHERE id=4").fetchone()[0]
        check("AC-3c unconvertible embedding -> NULL", emb4 is None)
        # AC-3c memories agent default for NULL
        ag5 = nconn.execute("SELECT agent_id FROM memories WHERE id=5").fetchone()[0]
        check("memories NULL agent_id defaulted to marveen", ag5 == "marveen")
        # OQ-1 sessions mapping
        sess = dict(nconn.execute("SELECT session_id, agent_id FROM sessions").fetchall())
        check("OQ-1 session mapped via conversation_log (123->claudia)", sess.get("sess-a") == "claudia")
        check("OQ-1 session unmappable -> marveen default", sess.get("sess-b") == "marveen")
        # scheduled_tasks defaults
        st = nconn.execute("SELECT agent, type FROM scheduled_tasks WHERE id='daily-x'").fetchone()
        check("scheduled_tasks agent + type populated", st is not None and st[0] and st[1])
        # kanban someday survives
        sd = nconn.execute("SELECT status FROM kanban_cards WHERE id='c2'").fetchone()[0]
        check("kanban 'someday' status preserved", sd == "someday")
        # AC-5 pragmas
        jm = nconn.execute("PRAGMA journal_mode").fetchone()[0]
        check("AC-5 journal_mode wal", jm.lower() == "wal")
        # AC-6a FTS count == memories count
        fc = nconn.execute("SELECT COUNT(*) FROM memories_fts").fetchone()[0]
        mc = nconn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        check(f"AC-6a FTS count == memories ({fc}=={mc})", fc == mc)
        # AC-6b FTS trigram substring match
        hit = nconn.execute("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'kanb'").fetchall()
        check("AC-6b FTS trigram substring 'kanb' matches", len(hit) >= 1)
        nconn.close()

        # STRIDE I2: perms 0600
        mode = oct(os.stat(dst).st_mode & 0o777)
        check("STRIDE I2 noa.db perms 0600", mode == "0o600")

        # AC-3a idempotent: re-run, same counts, no dup
        before = sqlite3.connect(dst).execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        r2 = run(["python3", MIGRATE, "--source", src, "--target", dst])
        check("AC-3a idempotent re-run exits 0", r2.returncode == 0)
        after = sqlite3.connect(dst).execute("SELECT COUNT(*) FROM memories").fetchone()[0]
        check(f"AC-3a idempotent: memories count stable ({before}=={after})", before == after)

        # AC-10 parity-check passes
        rp = run(["python3", PARITY, "--old", src, "--new", dst])
        check("AC-10 parity-check exits 0", rp.returncode == 0)
        check("AC-10 parity-check prints PASS", "PASS" in rp.stdout and "FAIL" not in rp.stdout)
        if rp.returncode != 0:
            print("parity stdout:\n" + rp.stdout)

    # AC-3d source untouched (read-only)
    check("AC-3d source DB mtime unchanged (read-only)", os.path.getmtime(src) == src_mtime_before)

    print(f"\n{PASS} passed, {FAIL} failed")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
