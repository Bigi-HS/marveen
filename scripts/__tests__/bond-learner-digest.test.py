#!/usr/bin/env python3
"""Tests for the Bond SessionStart learner-state digest (L-AC2, L-AC3, EXAM-AC2).

Covers: empty db -> "first session"; baseline-pending sentinel; populated
baseline summary; top-3 recurring errors with last example; corrections + vocab
due-for-review lists; last Daniel homework; days-since-last-session; the
200+-overdue cap (edge case); and the <=500-token (char-proxy) budget.

Run: python3 scripts/__tests__/bond-learner-digest.test.py
"""
import importlib.util
import os
import sqlite3
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BOND_DB_PATH = os.path.normpath(os.path.join(HERE, "..", "bond_db.py"))
HOOK_PATH = os.path.normpath(os.path.join(HERE, "..", "hooks", "bond-learner-digest.py"))


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bond_db = _load("bond_db", BOND_DB_PATH)
digest = _load("bond_learner_digest", HOOK_PATH)

NOW = 1_700_000_000  # fixed reference epoch
DAY = 86400


class DigestTest(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        os.unlink(self.path)
        bond_db.init_db(self.path)
        self.con = sqlite3.connect(self.path)

    def tearDown(self):
        self.con.close()
        if os.path.exists(self.path):
            os.unlink(self.path)

    # --- helpers ---
    def add_session(self, started, ended, stype="conversation"):
        self.con.execute(
            "INSERT INTO sessions (started_at, ended_at, type) VALUES (?,?,?)",
            (started, ended, stype),
        )
        self.con.commit()

    def add_correction(self, err, fix, category, turn_ts, due):
        self.con.execute(
            "INSERT INTO corrections (session_id, turn_ts, error_text, corrected_form,"
            " category, review_due_epoch) VALUES (NULL,?,?,?,?,?)",
            (turn_ts, err, fix, category, due),
        )
        self.con.commit()

    # --- empty ---
    def test_empty_db_says_first_session(self):
        out = digest.build_digest(self.con, NOW)
        self.assertIn("No prior history", out)
        self.assertIn("first session", out)

    # --- baseline ---
    def test_baseline_pending_sentinel_when_history_but_no_baseline(self):
        self.add_session(NOW - 2 * DAY, NOW - 2 * DAY + 600)
        out = digest.build_digest(self.con, NOW)
        self.assertIn("BASELINE PENDING", out)

    def test_baseline_summary_when_present(self):
        for skill, lvl in [("listening", "B1"), ("reading", "B2"),
                           ("writing", "B1"), ("speaking", "A2")]:
            self.con.execute(
                "INSERT INTO baseline_assessment (skill, level, assessed_at)"
                " VALUES (?,?,?)", (skill, lvl, NOW - 5 * DAY))
        self.con.commit()
        out = digest.build_digest(self.con, NOW)
        self.assertNotIn("BASELINE PENDING", out)
        self.assertIn("listening", out)
        self.assertIn("B2", out)

    # --- top errors ---
    def test_top_three_errors_by_frequency_with_last_example(self):
        # grammar x3, phrasing x2, vocab x1 -> top3 = grammar, phrasing, vocab
        self.add_correction("I has", "I have", "grammar", NOW - 3 * DAY, NOW + DAY)
        self.add_correction("he go", "he goes", "grammar", NOW - 2 * DAY, NOW + DAY)
        self.add_correction("I have went", "I have gone", "grammar", NOW - DAY, NOW + DAY)
        self.add_correction("make a photo", "take a photo", "phrasing", NOW - DAY, NOW + DAY)
        self.add_correction("do a mistake", "make a mistake", "phrasing", NOW - 2 * DAY, NOW + DAY)
        self.add_correction("informations", "information", "vocab", NOW - DAY, NOW + DAY)
        out = digest.build_digest(self.con, NOW)
        self.assertIn("grammar", out)
        self.assertIn("3", out)  # the grammar count
        # last grammar example is the most recent (turn_ts NOW-DAY)
        self.assertIn("I have gone", out)

    # --- due-for-review ---
    def test_corrections_due_for_review_listed(self):
        self.add_correction("I have went", "I have gone", "grammar",
                            NOW - 25 * 3600, NOW - 3600)  # overdue, and most recent
        self.add_correction("future err", "future fix", "grammar",
                            NOW - 50 * 3600, NOW + 10 * DAY)  # older + not due
        out = digest.build_digest(self.con, NOW)
        self.assertIn("I have gone", out)
        self.assertNotIn("future fix", out)  # not due and not the latest example

    def test_overdue_corrections_capped_at_ten(self):
        for i in range(200):
            # distinct turn_ts so the top-errors "last example" is deterministic
            # (i=199, most recent); distinct due so the overdue ordering is total.
            self.add_correction(f"err{i}", f"fix{i}", "grammar",
                                NOW - 2 * DAY + i, NOW - DAY - i)
        out = digest.build_digest(self.con, NOW)
        # only the 10 most-overdue (smallest due epoch) should appear
        self.assertIn("fix199", out)  # most overdue
        self.assertNotIn("fix0", out)  # least overdue, beyond top 10

    def test_vocab_due_today_listed(self):
        self.con.execute(
            "INSERT INTO vocab (word, review_due_epoch, interval_days)"
            " VALUES (?,?,?)", ("ubiquitous", NOW - 3600, 1))
        self.con.execute(
            "INSERT INTO vocab (word, review_due_epoch, interval_days)"
            " VALUES (?,?,?)", ("notdueyet", NOW + 10 * DAY, 4))
        self.con.commit()
        out = digest.build_digest(self.con, NOW)
        self.assertIn("ubiquitous", out)
        self.assertNotIn("notdueyet", out)

    # --- homework + recency ---
    def test_last_homework_shown(self):
        self.con.execute(
            "INSERT INTO lessons (topic, homework_text, next_lesson_date, created_at)"
            " VALUES (?,?,?,?)",
            ("conditionals", "Write 5 third-conditional sentences", "2026-06-21", NOW - DAY))
        self.con.commit()
        out = digest.build_digest(self.con, NOW)
        self.assertIn("conditionals", out)
        self.assertIn("third-conditional", out)

    def test_days_since_last_session(self):
        self.add_session(NOW - 4 * DAY, NOW - 4 * DAY + 600)
        out = digest.build_digest(self.con, NOW)
        self.assertIn("4", out)

    # --- budget ---
    def test_digest_within_char_budget(self):
        for i in range(200):
            self.add_correction(f"error number {i} is long" * 3, f"fix {i}" * 3,
                                "grammar", NOW - 2 * DAY, NOW - DAY)
        for i in range(200):
            self.con.execute(
                "INSERT INTO vocab (word, context_sentence, review_due_epoch, interval_days)"
                " VALUES (?,?,?,?)", (f"word{i}" * 5, "ctx" * 20, NOW - 3600, 1))
        self.con.commit()
        out = digest.build_digest(self.con, NOW)
        # ~500 tokens ~= 2000 chars; hard cap keeps the injection bounded.
        self.assertLessEqual(len(out), digest.MAX_DIGEST_CHARS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
