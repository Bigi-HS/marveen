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
  python3 scripts/migrate-to-noa.py --source <src.db> [--target store/noa.db] [--allow-overwrite]
Exits non-zero if any row-count parity check fails or a FK violation is found.

Safety (card c80cede3):
  * --source is REQUIRED and must be explicit. The old implicit store/claudeclaw.db
    default is revoked (ENG-024); migrating from that dead DB would destroy live data.
  * An existing --target is NOT overwritten in place unless --allow-overwrite is given;
    the safe default leaves the live DB untouched.
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

# The de-brand engine lives in the same scripts/ dir; make it importable whether this
# script is run as `python3 scripts/migrate-to-noa.py` or from elsewhere.
sys.path.insert(0, HERE)
from debrand_text import (  # noqa: E402
    apply as debrand_apply,
    classify as debrand_classify,
    contains_blocklist_token,
    partial_rewrite as debrand_partial_rewrite,
)

# Tables with a custom transform (everything else is copied verbatim).
REDESIGNED = {"memories", "agent_messages", "sessions", "scheduled_tasks"}
# Source-only tables that are never migrated as base tables.
SKIP = {"sqlite_sequence"}

PRIORITY_MAP = {"urgent": 100, "high": 75, "normal": 50, "low": 25}
DEFAULT_PRIORITY = 50
DEFAULT_AGENT = "noa"  # DA-5 flip (was "marveen"): fallback agent_id for defaulted rows
BATCH = 1000  # rows per insert transaction (OQ-3)

# SAFETY GUARDS (card c80cede3).
#   1. REVOKED_SOURCE: store/claudeclaw.db was frozen & revoked 2026-06-28 (ENG-024).
#      Running migration from it rebuilds the live DB from a dead source. We refuse to
#      touch it unless the operator passes it EXPLICITLY via --source.
#   2. The live target (store/noa.db) must never be overwritten in-place by accident.
#      If --target already exists, refuse unless --allow-overwrite is given.
REVOKED_SOURCE = os.path.join("store", "claudeclaw.db")  # display string (messages only)
DEFAULT_TARGET = os.path.join("store", "noa.db")

# Canonical, cwd-INDEPENDENT path to the revoked DB used by GUARD 1's comparison.
# Anchored to THIS script's directory (HERE) via the repo root (HERE/..), NOT to the
# process cwd.  os.path.realpath() on the RELATIVE REVOKED_SOURCE constant would resolve
# against the current working directory, so the guard would only work when invoked from
# repo-root and would FAIL OPEN from any other cwd (card 9346ee6a reroll:
# `cd /tmp && migrate-to-noa.py --source /abs/.../store/claudeclaw.db` sailed past the
# cwd-anchored guard). Computed once at import, independent of caller cwd.
try:
    REVOKED_SOURCE_CANON = os.path.realpath(
        os.path.join(HERE, os.pardir, "store", "claudeclaw.db")
    )
except OSError:
    # Fail-CLOSED: if we cannot canonicalize the revoked reference we cannot prove any
    # --source is NOT the revoked DB; the guard refuses rather than risk a live-data wipe.
    REVOKED_SOURCE_CANON = None

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


def blocklist_prescan(src):
    """Return [{id, content}] for every memories row whose content carries a blocklist
    (coordinated-infra) `marveen` token. These rows must be human-reviewed BEFORE the
    rewrite transform runs (AM-3): a historical memory quoting com.marveen.channels must
    not silently become com.noa.channels.
    """
    cols = table_columns(src, "memories")
    hits = []
    for row in src.execute("SELECT * FROM memories"):
        r = dict(zip(cols, row))
        content = r.get("content")
        if content is not None and contains_blocklist_token(content):
            hits.append({"id": r["id"], "content": content})
    return hits


def load_review_manifest(path):
    """Load the review-manifest sidecar: {"<row-id>": "keep"|"skip"|"mixed"}.

    Missing file => empty manifest (every row unreviewed). Keys are stringified ids.
    """
    if not path or not os.path.exists(path):
        return {}
    with open(path) as f:
        data = json.load(f)
    return {str(k): v for k, v in data.items()}


def assert_prescan_reviewed(prescan_rows, manifest):
    """HARD GATE (AM-3): every blocklist-token row id must be a key in the manifest.

    If ANY prescan row is unreviewed, print the list to stderr and sys.exit(3) -- zero
    unreviewed blocklist-token rows may enter the transform.
    """
    unreviewed = [r for r in prescan_rows if str(r["id"]) not in manifest]
    if unreviewed:
        print(
            "ERROR: blocklist-token rows not reviewed (set them in the review manifest "
            "before migrating):",
            file=sys.stderr,
        )
        for r in unreviewed:
            snippet = (r["content"] or "")[:80].replace("\n", " ")
            print(f"  id={r['id']}: {snippet}", file=sys.stderr)
        sys.exit(3)


def migrate_memories(src, dst, manifest=None):
    manifest = manifest or {}
    cols = table_columns(src, "memories")
    out = []
    for row in src.execute("SELECT * FROM memories"):
        r = dict(zip(cols, row))
        raw = r.get("content") if r.get("content") is not None else ""
        # Content transform (Pass 4): manifest 'keep' -> verbatim; else run the engine
        # (REWRITE applies; REFUSE/NOOP leave content unchanged).
        if manifest.get(str(r["id"])) == "keep":
            content = raw
        elif manifest.get(str(r["id"])) == "mixed":
            content, _verdict = debrand_partial_rewrite(raw)
        else:
            content, _verdict = debrand_apply(raw, context="memory")
        out.append(
            (
                r["id"],
                r.get("agent_id") or DEFAULT_AGENT,
                r.get("category") or "general",
                content,
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
            warn(f"session {r.get('session_id')} agent defaulted to {DEFAULT_AGENT} -- REVIEW")
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


def run_report(src):
    """NON-MUTATING audit pass (--report). Open source read-only, classify every memory
    content, print a human-readable summary. MUST NOT create or modify noa.db or any tmp.
    """
    prescan = blocklist_prescan(src)
    cols = table_columns(src, "memories")
    counts = {"REWRITE": 0, "NOOP": 0}
    refuse_by_tag = {}
    glance = []  # M2/M3 needs_glance candidates
    for row in src.execute("SELECT * FROM memories"):
        r = dict(zip(cols, row))
        content = r.get("content")
        if content is None:
            content = ""
        v = debrand_classify(content, context="memory")
        if v.action == "REWRITE":
            counts["REWRITE"] += 1
        elif v.action == "NOOP":
            counts["NOOP"] += 1
        else:  # REFUSE
            refuse_by_tag[v.tag] = refuse_by_tag.get(v.tag, 0) + 1
        if v.needs_glance:
            snippet = content[:80].replace("\n", " ")
            glance.append((r["id"], v.action, v.tag, snippet))

    print("=== Pass-4 memory de-brand report (NON-MUTATING) ===")
    print(f"REWRITE: {counts['REWRITE']}")
    print(f"NOOP:    {counts['NOOP']}")
    print("REFUSE by tag:")
    for tag in sorted(refuse_by_tag):
        print(f"  {tag}: {refuse_by_tag[tag]}")
    print(f"\nBlocklist-token rows needing review ({len(prescan)}):")
    for r in prescan:
        snippet = (r["content"] or "")[:80].replace("\n", " ")
        print(f"  id={r['id']}: {snippet}")
    print(f"\nM2/M3 needs-glance candidates ({len(glance)}):")
    for rid, action, tag, snippet in glance:
        print(f"  id={rid} [{action}/{tag}]: {snippet}")


def main():
    ap = argparse.ArgumentParser()
    # NOTE (card c80cede3): --source/--target default to None sentinels so we can
    # reliably tell whether the operator passed them EXPLICITLY. The safety guards
    # below depend on this distinction; do not restore literal-path defaults here.
    ap.add_argument(
        "--source",
        default=None,
        help="Source DB (read-only). REQUIRED: must be given explicitly -- the old "
        "store/claudeclaw.db default was revoked (ENG-024).",
    )
    ap.add_argument(
        "--target",
        default=None,
        help="Target DB to build (defaults to store/noa.db). Refuses to overwrite an "
        "existing target unless --allow-overwrite is passed.",
    )
    ap.add_argument("--review-manifest", default="store/debrand-review.json")
    ap.add_argument(
        "--report",
        action="store_true",
        help="NON-MUTATING audit: classify memory content, print summary, create nothing.",
    )
    ap.add_argument(
        "--allow-overwrite",
        action="store_true",
        help="Opt-in to overwrite an EXISTING target DB in place. Without this flag the "
        "migration refuses to clobber an existing (possibly live) target DB.",
    )
    args = ap.parse_args()

    # GUARD 1 (card c80cede3): refuse the revoked claudeclaw.db default.
    # --source must be passed EXPLICITLY; there is no implicit source any more. Falling
    # back to store/claudeclaw.db (frozen/revoked 2026-06-28, ENG-024) would rebuild the
    # target from a dead source and destroy live data.
    if args.source is None:
        print(
            "ERROR: --source is required and must be given explicitly.\n"
            f"       The old implicit default ({REVOKED_SOURCE}) is REVOKED (ENG-024, "
            "frozen 2026-06-28);\n"
            "       migrating from it would rebuild the target from a dead DB and lose "
            "live data.\n"
            "       Pass an explicit --source <path> to the DB you really intend to "
            "migrate from.",
            file=sys.stderr,
        )
        sys.exit(2)
    # GUARD 1 (card 9346ee6a harden + reroll): realpath-canonicalize both sides so that
    # an ABSOLUTE path (/abs/.../store/claudeclaw.db) or a SYMLINK pointing at the revoked
    # file are both caught.  os.path.normpath only normalises "." / ".." and does NOT
    # resolve symlinks or expand to absolute -- bypass was possible with either vector.
    # The revoked side is pre-canonicalized to REVOKED_SOURCE_CANON, anchored to this
    # script's directory (NOT the process cwd); realpath'ing the RELATIVE constant here
    # would re-introduce the cwd-dependent fail-open (see REVOKED_SOURCE_CANON note).
    # Belt-and-suspenders: if the supplied source already exists on disk, also use
    # os.path.samefile which compares inodes (catches hardlinks and any other alias).
    if REVOKED_SOURCE_CANON is None:
        # Fail-CLOSED: revoked reference could not be canonicalized -> cannot prove the
        # source is safe, so refuse rather than risk migrating from the dead DB.
        print(
            "ERROR: cannot canonicalize the REVOKED source reference; refusing to "
            "migrate (fail-closed).",
            file=sys.stderr,
        )
        sys.exit(2)
    _revoked_real = REVOKED_SOURCE_CANON
    _source_real = os.path.realpath(args.source)
    _same_realpath = (_source_real == _revoked_real)
    _same_inode = (
        os.path.exists(args.source)
        and os.path.exists(_revoked_real)
        and os.path.samefile(args.source, _revoked_real)
    )
    if _same_realpath or _same_inode:
        print(
            f"ERROR: refusing to migrate from the REVOKED source {REVOKED_SOURCE} "
            "(ENG-024, frozen 2026-06-28).\n"
            "       This DB is dead; migrating from it would destroy live data. Pass a "
            "live/intended source instead.",
            file=sys.stderr,
        )
        sys.exit(2)

    # Resolve the (possibly defaulted) target now that the source guard has passed.
    if args.target is None:
        args.target = DEFAULT_TARGET

    if not os.path.exists(args.source):
        print(f"ERROR: source DB not found: {args.source}", file=sys.stderr)
        sys.exit(2)

    manifest = load_review_manifest(args.review_manifest)

    # --report: read-only audit, create/modify nothing, exit 0.
    if args.report:
        src = sqlite3.connect(f"file:{args.source}?mode=ro", uri=True)
        src.execute("PRAGMA query_only = ON")
        try:
            prescan = blocklist_prescan(src)
            run_report(src)
            unreviewed = [r for r in prescan if str(r["id"]) not in manifest]
            if unreviewed:
                print(
                    f"\nNOTE: {len(unreviewed)} blocklist-token row(s) unreviewed "
                    "(real migration would exit 3 until reviewed).",
                    file=sys.stderr,
                )
        finally:
            src.close()
        sys.exit(0)

    # GUARD 2 (card c80cede3): never overwrite an EXISTING target DB in place.
    # The final step of the build is os.replace(tmp, target), an atomic in-place
    # overwrite. If the target already exists (e.g. the live store/noa.db) refuse unless
    # the operator explicitly opted in with --allow-overwrite. The safe default leaves
    # the live DB byte-for-byte untouched.
    if os.path.exists(args.target) and not args.allow_overwrite:
        print(
            f"ERROR: target DB already exists: {args.target}\n"
            "       Refusing to overwrite it in place (it may be the LIVE DB; an "
            "overwrite from a\n"
            "       smaller/older source would destroy memories, kanban and messages).\n"
            "       Either write to a NEW target path (--target <new-path>) or, if you "
            "REALLY mean\n"
            "       to rebuild this DB in place, pass --allow-overwrite explicitly.",
            file=sys.stderr,
        )
        sys.exit(2)

    tmp = args.target + ".tmp"
    for sidecar in (tmp, tmp + "-wal", tmp + "-shm"):
        if os.path.exists(sidecar):
            os.remove(sidecar)
    if os.path.exists(args.target):
        print(f"INFO: {args.target} exists, rebuilding atomically (--allow-overwrite given)")

    # Source: strictly read-only.
    src = sqlite3.connect(f"file:{args.source}?mode=ro", uri=True)
    src.execute("PRAGMA query_only = ON")
    src_tabs = source_tables(src)

    # HARD GATE (AM-3): zero unreviewed blocklist-token memory rows may enter the
    # transform. Runs BEFORE building noa.db so nothing is written on a gate failure.
    if "memories" in src_tabs:
        assert_prescan_reviewed(blocklist_prescan(src), manifest)

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
        migrate_memories(src, dst, manifest)
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

    # TOCTOU note (card 9346ee6a, INFO / Chad SEC advisory, NOT fixed here):
    # There is a narrow race window between the GUARD-2 exists()-check above and this
    # os.replace().  An adversary with filesystem-write access could create/replace
    # args.target in that window.  Exploitation requires local filesystem-write, which
    # is out of scope for the CLI threat model (operator-run tool).  Mitigations would
    # be: (a) open/lock the target path with O_CREAT|O_EXCL before the migration run,
    # (b) add a final re-check immediately before os.replace, or (c) use a target-side
    # file-descriptor lock held for the full run.  Deferred; document here so it is not
    # silently forgotten.  Threat-model reference: shared-redirect-strip-must-normalize
    # + shared-egress-path-anchor (same path-normalisation bypass class).

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
