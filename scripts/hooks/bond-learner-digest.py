#!/usr/bin/env python3
"""SessionStart hook: inject Bond's longitudinal learner-state digest (L-AC2).

Bond is a 6-month tutor whose process outlives many Dominik sessions and whose
context is periodically compacted. To stay coherent it must NOT rely on chat
memory for "what we've covered" -- the truth lives in bond.db. This hook reads
bond.db at process start and injects a terse (<=500-token) digest: current
assessed baseline, top recurring error patterns, items due for SRS review,
the last Daniel homework, and days since the last session.

Contract mirrors memory-replay.py: read {cwd, source} on stdin, emit
SessionStart additionalContext, and NEVER break session start (always exit 0).
Injected on `startup` only (a --continue resume already carries the prior
digest in context; re-injecting would duplicate).

The digest builder (`build_digest`) is a pure function over an sqlite3
connection so it is unit-tested directly. bond.db path: $BOND_DB_PATH, else
<cwd>/bond.db (Bond's working dir is agents/bond).
"""
import json
import os
import sqlite3
import sys
import time

INJECT_SOURCES = {"startup"}
MAX_DIGEST_CHARS = 2000  # ~500 tokens; hard cap on the injected block

HEADER = (
    "BOND LEARNER-STATE (SessionStart, from bond.db). Re-prime from this -- do "
    "NOT rely on conversation memory for what has been covered. Reflects the db "
    "at boot; persist every new correction/lesson/vocab immediately."
)


def _count(con, table):
    return con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def _baseline_line(con):
    rows = con.execute(
        "SELECT skill, level FROM baseline_assessment WHERE level IS NOT NULL"
        " ORDER BY skill"
    ).fetchall()
    if not rows:
        return "Assessed baseline: BASELINE PENDING -- session 1 diagnostic not yet completed."
    parts = [f"{skill} {level}" for skill, level in rows]
    return "Assessed baseline: " + "; ".join(parts) + "."


def _top_errors_line(con):
    # SQLite bare-column-with-MAX special case: error_text/corrected_form come
    # from the row with the most recent turn_ts in each category group.
    rows = con.execute(
        "SELECT category, COUNT(*) AS c, error_text, corrected_form, MAX(turn_ts)"
        " FROM corrections GROUP BY category ORDER BY c DESC, MAX(turn_ts) DESC"
        " LIMIT 3"
    ).fetchall()
    if not rows:
        return None
    parts = []
    for category, c, err, fix, _ in rows:
        cat = category or "uncategorised"
        parts.append(f'{cat} ({c}x, last: "{err}" -> "{fix}")')
    return "Top recurring errors: " + "; ".join(parts)


def _due_corrections_line(con, now):
    rows = con.execute(
        "SELECT error_text, corrected_form FROM corrections"
        " WHERE review_due_epoch <= ? ORDER BY review_due_epoch ASC LIMIT 10",
        (now,),
    ).fetchall()
    if not rows:
        return None
    items = "; ".join(f'"{err}" -> "{fix}"' for err, fix in rows)
    return f"Corrections due for review ({len(rows)}): {items}"


def _due_vocab_line(con, now):
    rows = con.execute(
        "SELECT word FROM vocab WHERE review_due_epoch <= ?"
        " ORDER BY review_due_epoch ASC LIMIT 10",
        (now,),
    ).fetchall()
    if not rows:
        return None
    return f"Vocab due today ({len(rows)}): " + ", ".join(w for (w,) in rows)


def _last_homework_line(con):
    row = con.execute(
        "SELECT topic, homework_text, next_lesson_date FROM lessons"
        " ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    if not row:
        return "Last Daniel homework: none recorded."
    topic, hw, due = row
    due_str = f" (due {due})" if due else ""
    return f"Last Daniel homework: {topic} -- {hw}{due_str}"


def _days_since_session_line(con, now):
    row = con.execute(
        "SELECT MAX(COALESCE(ended_at, started_at)) FROM sessions"
    ).fetchone()
    if not row or row[0] is None:
        return None
    days = int(round((now - row[0]) / 86400))
    return f"Days since last session: {days}"


def build_digest(con, now):
    """Return the learner-state digest text (no header), capped to the budget."""
    history = sum(
        _count(con, t)
        for t in ("sessions", "corrections", "vocab", "lessons",
                  "baseline_assessment", "daily_check")
    )
    if history == 0:
        return "No prior history -- first session."

    lines = [_baseline_line(con)]
    for line in (
        _top_errors_line(con),
        _due_corrections_line(con, now),
        _due_vocab_line(con, now),
        _last_homework_line(con),
        _days_since_session_line(con, now),
    ):
        if line:
            lines.append(line)

    text = "\n".join(lines)
    if len(text) > MAX_DIGEST_CHARS:
        text = text[: MAX_DIGEST_CHARS - 14].rstrip() + "\n...[truncated]"
    return text


def _db_path(cwd):
    override = os.environ.get("BOND_DB_PATH")
    if override:
        return override
    base = cwd or os.getcwd()
    return os.path.join(base, "bond.db")


def main():
    cwd = None
    source = "startup"
    try:
        payload = json.load(sys.stdin)
        cwd = payload.get("cwd")
        source = payload.get("source") or "startup"
    except Exception:
        pass

    if source not in INJECT_SOURCES:
        sys.exit(0)

    path = _db_path(cwd)
    if not os.path.exists(path):
        sys.exit(0)  # not yet initialised -> no-op, never break session start

    try:
        con = sqlite3.connect(path, timeout=10)
        try:
            digest = build_digest(con, int(time.time()))
        finally:
            con.close()
    except Exception:
        sys.exit(0)

    out = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": HEADER + "\n\n" + digest,
        }
    }
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
