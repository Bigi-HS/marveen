#!/usr/bin/env python3
"""mem-rescope-safe-pii: re-scope memories that were auto-narrowed by the OLD PII classifier
but no longer match the NEW (word-start) classifier (card 07596e45, MEM-018).

Background: PR#481 (8ad3a1c9) fixed bare-substring PII matching to word-start matching.
This eliminated phantom PII hits (e.g. "taj" in "listaja", "zip" in "gzip"). But
memories already scoped by the old classifier still carry the restricted access_scope.

This script identifies memories where:
  - access_scope IS NOT NULL (was scoped, presumably by PII auto-scope)
  - the CONTENT does NOT match the NEW classifier
  -> safe to re-scope to NULL (broader, unscoped)

Direction is ONLY broadening: 0 rows become newly PII (the new classifier is stricter).
The change is safe and reversible (access_scope can be re-set from the API).

Usage:
    python3 scripts/mem-rescope-safe-pii.py           # dry-run (show candidates)
    python3 scripts/mem-rescope-safe-pii.py --apply   # re-scope + log
    python3 scripts/mem-rescope-safe-pii.py --agent marveen  # filter by agent

Each re-scope is recorded in a migration_log table (like vault-lint-apply-safe-tm).
"""
import os
import re
import sqlite3
import sys
import unicodedata

# ---------------------------------------------------------------------------
# New PII classifier (mirrors src/noa-memory.ts isPotentialPII, 8ad3a1c9)
# ---------------------------------------------------------------------------
PII_KEYWORDS = [
    'egészség', 'health', 'orvos', 'doctor', 'betegség', 'illness',
    'gyógyszer', 'medication', 'diagnózis', 'diagnosis',
    'home address', 'lakcím', 'születésnap', 'birthday', 'személyes', 'personal schedule',
    'cím', 'address', 'irányítószám', 'zip', 'postal',
    'bank', 'bankszámla', 'hitelkártya', 'credit card', 'fizetés', 'iban', 'számlaszám',
    'taj', 'személyi', 'adóazonosító', 'adószám',
]


def deaccent(s: str) -> str:
    return unicodedata.normalize('NFD', s.lower()).encode('ascii', 'ignore').decode()


def build_pattern(kw: str):
    safe = re.escape(deaccent(kw))
    return re.compile(r'(?:^|[^\w\d])' + safe, re.UNICODE | re.MULTILINE)


PII_PATTERNS = [build_pattern(kw) for kw in PII_KEYWORDS]


def is_pii_new(keywords: str | None, content: str) -> bool:
    hay = deaccent(f"{keywords or ''}\n{content}")
    return any(p.search(hay) for p in PII_PATTERNS)


# ---------------------------------------------------------------------------
# DB
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.normpath(os.path.join(HERE, '..'))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from db_resolve import resolve_default_db  # noqa: E402

DB_PATH = resolve_default_db(project_root=PROJECT_ROOT)

MIGRATION_LOG_DDL = """
CREATE TABLE IF NOT EXISTS migration_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at       INTEGER NOT NULL,
    memory_id    INTEGER NOT NULL,
    agent_id     TEXT    NOT NULL,
    old_scope    TEXT,
    new_scope    TEXT,
    rule         TEXT    NOT NULL,
    dry_run      INTEGER NOT NULL DEFAULT 0
)
"""


def find_candidates(conn: sqlite3.Connection, agent_filter: str | None) -> list[dict]:
    """Return memories with access_scope set that no longer match the new PII classifier."""
    q = "SELECT id, agent_id, content, keywords, access_scope FROM memories WHERE access_scope IS NOT NULL"
    params = []
    if agent_filter:
        q += " AND agent_id = ?"
        params.append(agent_filter)
    rows = conn.execute(q, params).fetchall()
    candidates = []
    for row in rows:
        mem_id, agent_id, content, keywords, access_scope = row
        if not is_pii_new(keywords, content or ''):
            candidates.append({
                'id': mem_id,
                'agent_id': agent_id,
                'old_scope': access_scope,
                'content_preview': (content or '')[:80],
            })
    return candidates


def apply_rescope(conn: sqlite3.Connection, candidates: list[dict], now: int, dry_run: bool) -> int:
    conn.execute(MIGRATION_LOG_DDL)
    count = 0
    for c in candidates:
        if not dry_run:
            conn.execute("UPDATE memories SET access_scope = NULL WHERE id = ?", (c['id'],))
        conn.execute(
            "INSERT INTO migration_log (run_at, memory_id, agent_id, old_scope, new_scope, rule, dry_run) "
            "VALUES (?, ?, ?, ?, NULL, 'MEM-018-pii-rescope', ?)",
            (now, c['id'], c['agent_id'], c['old_scope'], 1 if dry_run else 0),
        )
        count += 1
    conn.commit()
    return count


def main() -> int:
    import time
    dry_run = '--apply' not in sys.argv
    agent_filter = None
    if '--agent' in sys.argv:
        idx = sys.argv.index('--agent')
        if idx + 1 < len(sys.argv):
            agent_filter = sys.argv[idx + 1]

    now = int(time.time())
    conn = sqlite3.connect(DB_PATH)
    try:
        candidates = find_candidates(conn, agent_filter)
        mode = 'DRY-RUN' if dry_run else 'APPLY'
        print(f"mem-rescope-safe-pii [{mode}] db={DB_PATH}")
        print(f"  agent filter: {agent_filter or 'all'}")
        print(f"  candidates (would re-scope): {len(candidates)}")
        if not candidates:
            print("  Nothing to re-scope.")
            return 0
        for c in candidates:
            action = "would re-scope" if dry_run else "re-scoped"
            print(f"  [{action}] id={c['id']} agent={c['agent_id']} scope={c['old_scope']!r} "
                  f"preview={c['content_preview']!r}")
        applied = apply_rescope(conn, candidates, now, dry_run)
        print(f"  Total {'would apply' if dry_run else 'applied'}: {applied}")
        return 0
    finally:
        conn.close()


if __name__ == '__main__':
    sys.exit(main())
