#!/usr/bin/env python3
"""bond.db schema + initialiser for the Bond English-tutor agent.

Bond is a LONGITUDINAL agent (6-month arc): every correction, lesson, and
vocabulary item is persisted immediately so a fresh context window can be
re-primed from the database rather than from conversation memory (spec L-AC1).
This module is the single source of truth for the schema (the spec's "Schema
Inventory (authoritative)" table) and is importable by the SessionStart digest
hook as well as runnable to create/upgrade the file at deploy time:

    python3 scripts/bond_db.py --db agents/bond/bond.db

Idempotent: CREATE TABLE IF NOT EXISTS, safe to re-run. Columns match the spec
inventory exactly -- do NOT add columns derived from individual ACs.
"""
import argparse
import sqlite3

# The six authoritative tables (spec: bond.db Schema Inventory). Column sets are
# taken verbatim from the inventory; types/PKs are the natural SQLite mapping.
SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at   INTEGER NOT NULL,                 -- epoch seconds
    ended_at     INTEGER,                          -- epoch seconds, null while open
    type         TEXT    NOT NULL,                 -- homework/conversation/daily_check/diagnostic
    turn_count   INTEGER NOT NULL DEFAULT 0,
    format_cycle TEXT                              -- IELTS/TOEIC/CAE, null in trial
);

CREATE TABLE IF NOT EXISTS lessons (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       INTEGER REFERENCES sessions(id),
    topic            TEXT,
    homework_text    TEXT,
    next_lesson_date TEXT,                         -- ISO date or null (from Claudia trigger)
    format_cycle     TEXT,
    created_at       INTEGER NOT NULL              -- epoch seconds
);

CREATE TABLE IF NOT EXISTS corrections (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       INTEGER REFERENCES sessions(id),
    turn_ts          INTEGER NOT NULL,             -- epoch seconds of the corrected turn
    error_text       TEXT    NOT NULL,
    corrected_form   TEXT    NOT NULL,
    category         TEXT,                         -- grammar/vocab/phrasing/...
    review_due_epoch INTEGER NOT NULL              -- SRS due time (L-AC3)
);

CREATE TABLE IF NOT EXISTS vocab (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    word             TEXT    NOT NULL,
    context_sentence TEXT,
    review_due_epoch INTEGER NOT NULL,
    interval_days    INTEGER NOT NULL DEFAULT 1    -- SRS doubling base
);

CREATE TABLE IF NOT EXISTS baseline_assessment (
    skill       TEXT PRIMARY KEY,                  -- listening/reading/writing/speaking
    level       TEXT,                              -- A2/B1/B2/C1
    notes       TEXT,
    assessed_at INTEGER                            -- epoch seconds
);

CREATE TABLE IF NOT EXISTS daily_check (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    date              INTEGER NOT NULL,            -- epoch seconds of day start
    duolingo_reported INTEGER,                     -- chapters self-reported (DC-AC1)
    notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_corrections_due ON corrections(review_due_epoch);
CREATE INDEX IF NOT EXISTS idx_vocab_due ON vocab(review_due_epoch);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
"""

# The exact set of tables the digest hook and the trial-gate check rely on.
TABLES = (
    "sessions",
    "lessons",
    "corrections",
    "vocab",
    "baseline_assessment",
    "daily_check",
)


def init_db(path):
    """Create the schema in the SQLite file at `path` (idempotent)."""
    con = sqlite3.connect(path, timeout=10)
    try:
        con.executescript(SCHEMA)
        con.commit()
    finally:
        con.close()


def main():
    ap = argparse.ArgumentParser(description="Initialise bond.db schema (idempotent).")
    ap.add_argument("--db", required=True, help="path to bond.db")
    args = ap.parse_args()
    init_db(args.db)
    print(f"bond.db schema ensured at {args.db}")


if __name__ == "__main__":
    main()
