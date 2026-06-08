#!/usr/bin/env python3
"""Tests for the SessionStart memory auto-inject (rank policy + hook).

Run: python3 scripts/hooks/test_memory_autoinject.py
"""
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import memory_rank  # noqa: E402

_INSTALL = os.path.dirname(os.path.dirname(_HERE))  # <install>/scripts/hooks -> <install>
_HOOK = os.path.join(_HERE, "memory-replay.py")
_NOW = 1_700_000_000

_MEMORIES_SCHEMA = """
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  topic_key TEXT,
  content TEXT NOT NULL,
  sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
  salience REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'marveen',
  category TEXT NOT NULL DEFAULT 'warm' CHECK(category IN ('hot','warm','cold','shared')),
  auto_generated INTEGER NOT NULL DEFAULT 0,
  keywords TEXT,
  embedding TEXT
)
"""


def _m(category, agent_id, salience, accessed_at=0, content="x", topic_key="", keywords="", created_at=None):
    return {
        "category": category, "agent_id": agent_id, "salience": salience,
        "accessed_at": accessed_at, "content": content, "topic_key": topic_key,
        "keywords": keywords, "created_at": created_at if created_at is not None else _NOW,
    }


class RankTests(unittest.TestCase):
    def test_split_3_warm_2_shared_and_order(self):
        cands = (
            [_m("warm", "dave", s, topic_key=f"w{s}") for s in (5, 4, 3, 2, 1)]
            + [_m("shared", "thor", s, topic_key=f"s{s}") for s in (9, 8, 7)]
        )
        out = memory_rank.rank_memories(cands, "dave", k=5, split=(3, 2))
        self.assertEqual([x["topic_key"] for x in out], ["w5", "w4", "w3", "s9", "s8"])

    def test_accessed_at_tiebreak(self):
        cands = [
            _m("warm", "dave", 3.0, accessed_at=100, topic_key="older"),
            _m("warm", "dave", 3.0, accessed_at=200, topic_key="newer"),
        ]
        out = memory_rank.rank_memories(cands, "dave", k=5, split=(3, 2))
        self.assertEqual([x["topic_key"] for x in out], ["newer", "older"])

    def test_only_own_warm_and_any_shared(self):
        cands = [
            _m("warm", "dave", 5, topic_key="mine"),
            _m("warm", "thor", 9, topic_key="not-mine"),   # other agent's warm -> excluded
            _m("shared", "thor", 4, topic_key="fleet"),     # shared from anyone -> included
        ]
        out = memory_rank.rank_memories(cands, "dave", k=5, split=(3, 2))
        keys = {x["topic_key"] for x in out}
        self.assertIn("mine", keys)
        self.assertIn("fleet", keys)
        self.assertNotIn("not-mine", keys)

    def test_hot_and_cold_excluded(self):
        cands = [
            _m("hot", "dave", 9, topic_key="hot"),
            _m("cold", "dave", 9, topic_key="cold"),
            _m("warm", "dave", 1, topic_key="warm"),
        ]
        out = memory_rank.rank_memories(cands, "dave", k=5, split=(3, 2))
        self.assertEqual([x["topic_key"] for x in out], ["warm"])

    def test_tier_fill_when_shared_short(self):
        # only 1 shared -> the 2nd shared slot is filled from leftover warm.
        cands = (
            [_m("warm", "dave", s, topic_key=f"w{s}") for s in (5, 4, 3, 2)]
            + [_m("shared", "x", 9, topic_key="s9")]
        )
        out = memory_rank.rank_memories(cands, "dave", k=5, split=(3, 2))
        keys = [x["topic_key"] for x in out]
        self.assertEqual(keys[:4], ["w5", "w4", "w3", "s9"])
        self.assertEqual(keys[4], "w2")  # gap filled from leftover warm
        self.assertEqual(len(out), 5)

    def test_tier_fill_when_warm_short(self):
        cands = (
            [_m("warm", "dave", 5, topic_key="w5")]
            + [_m("shared", "x", s, topic_key=f"s{s}") for s in (9, 8, 7, 6)]
        )
        out = memory_rank.rank_memories(cands, "dave", k=5, split=(3, 2))
        keys = [x["topic_key"] for x in out]
        self.assertEqual(keys[0], "w5")
        self.assertEqual(keys[1:3], ["s9", "s8"])   # the 2 shared slots
        self.assertEqual(set(keys[3:]), {"s7", "s6"})  # filled from leftover shared
        self.assertEqual(len(out), 5)

    def test_k_cap(self):
        cands = [_m("warm", "dave", s) for s in range(20)]
        self.assertEqual(len(memory_rank.rank_memories(cands, "dave", k=5, split=(3, 2))), 5)


class FormatTests(unittest.TestCase):
    def test_line_shape(self):
        m = _m("warm", "dave", 3, content="Hello world body", topic_key="My Title",
               keywords="kw1,kw2", created_at=_NOW - 2 * 86400)
        line = memory_rank._line(m, _NOW)
        self.assertTrue(line.startswith("- [WARM] My Title: Hello world body ("))
        self.assertIn("kw1,kw2", line)
        self.assertIn("2d old", line)

    def test_excerpt_truncation(self):
        long = "a" * 200
        self.assertEqual(len(memory_rank._excerpt(long, 80)), 80)  # 79 chars + ellipsis
        self.assertTrue(memory_rank._excerpt(long, 80).endswith("…"))
        self.assertEqual(memory_rank._excerpt("short", 80), "short")

    def test_age_labels(self):
        self.assertEqual(memory_rank._age_label(_NOW - 3 * 86400, _NOW), "3d old")
        self.assertEqual(memory_rank._age_label(_NOW - 5 * 3600, _NOW), "5h old")
        self.assertEqual(memory_rank._age_label(_NOW - 120, _NOW), "2m old")

    def test_title_falls_back_to_content_lead(self):
        m = _m("shared", "x", 1, content="alpha beta gamma delta epsilon zeta eta", topic_key="")
        self.assertEqual(memory_rank._title(m), "alpha beta gamma delta epsilon zeta")

    def test_char_budget_drops_tail(self):
        mems = [_m("warm", "dave", 5 - i, content="c" * 79, topic_key=f"t{i}") for i in range(5)]
        block = memory_rank.format_block(mems, _NOW, char_budget=200)
        self.assertLessEqual(len(block), 200 + 1)
        self.assertGreaterEqual(len(block.splitlines()), 1)


class HookIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mem-inject-")
        self.db = os.path.join(self.tmp, "claudeclaw.db")
        con = sqlite3.connect(self.db)
        con.executescript(_MEMORIES_SCHEMA)
        rows = [
            ("warm", "dave", 5.0, "w-top",  "semantic"),
            ("warm", "dave", 4.0, "w-mid",  "semantic"),
            ("warm", "dave", 3.0, "w-low",  "semantic"),
            ("warm", "dave", 1.0, "w-least", "semantic"),
            ("shared", "thor", 9.0, "sh-top", "semantic"),
            ("shared", "chad", 8.0, "sh-mid", "semantic"),
            ("shared", "x", 2.0, "sh-low", "semantic"),
            ("cold", "dave", 9.9, "cold-x", "semantic"),
            ("hot", "dave", 9.9, "hot-x", "semantic"),
            ("warm", "thor", 9.9, "other-warm", "semantic"),
        ]
        for cat, aid, sal, topic, sector in rows:
            con.execute(
                "INSERT INTO memories (chat_id, topic_key, content, sector, salience,"
                " created_at, accessed_at, agent_id, category) VALUES (?,?,?,?,?,?,?,?,?)",
                ("c", topic, f"body of {topic}", sector, sal, _NOW, _NOW, aid, cat),
            )
        con.commit()
        con.close()

    def _run(self, source="startup", agent="dave"):
        payload = {"source": source, "cwd": os.path.join(_INSTALL, "agents", agent)}
        env = dict(os.environ, MEMORY_DB_PATH=self.db)
        p = subprocess.run([sys.executable, _HOOK], input=json.dumps(payload),
                           capture_output=True, text=True, env=env, timeout=20)
        return p

    def test_startup_injects_ranked_set(self):
        p = self._run("startup")
        self.assertEqual(p.returncode, 0)
        ctx = json.loads(p.stdout)["hookSpecificOutput"]["additionalContext"]
        # top-3 own warm + top-2 shared, by salience
        for t in ("w-top", "w-mid", "w-low", "sh-top", "sh-mid"):
            self.assertIn(t, ctx)
        # excluded: 4th warm (over the 3-slot + no fill needed), cold, hot, other-agent warm, low shared
        for t in ("cold-x", "hot-x", "other-warm", "sh-low", "w-least"):
            self.assertNotIn(t, ctx)
        self.assertIn("[WARM]", ctx)
        self.assertIn("[SHARED]", ctx)

    def test_resume_does_not_inject(self):
        p = self._run("resume")
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout.strip(), "")

    def test_clear_does_not_inject(self):
        p = self._run("clear")
        self.assertEqual(p.stdout.strip(), "")

    def test_agent_scope_isolation(self):
        # gauge has no own warm and the shared pool is fleet-wide -> only shared shows.
        p = self._run("startup", agent="gauge")
        ctx = json.loads(p.stdout)["hookSpecificOutput"]["additionalContext"]
        self.assertIn("sh-top", ctx)
        self.assertNotIn("w-top", ctx)        # dave's warm not leaked to gauge
        self.assertNotIn("other-warm", ctx)   # thor's warm not leaked either

    def test_empty_store_is_noop(self):
        empty = os.path.join(self.tmp, "empty.db")
        con = sqlite3.connect(empty)
        con.executescript(_MEMORIES_SCHEMA)
        con.commit()
        con.close()
        env = dict(os.environ, MEMORY_DB_PATH=empty)
        payload = {"source": "startup", "cwd": os.path.join(_INSTALL, "agents", "dave")}
        p = subprocess.run([sys.executable, _HOOK], input=json.dumps(payload),
                           capture_output=True, text=True, env=env, timeout=20)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout.strip(), "")

    def test_missing_db_is_noop_not_crash(self):
        env = dict(os.environ, MEMORY_DB_PATH=os.path.join(self.tmp, "nope.db"))
        payload = {"source": "startup", "cwd": os.path.join(_INSTALL, "agents", "dave")}
        p = subprocess.run([sys.executable, _HOOK], input=json.dumps(payload),
                           capture_output=True, text=True, env=env, timeout=20)
        # a missing DB -> the memories-table query raises -> caught -> no-op, exit 0
        # (the hook must never break session start, whatever the store state)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(p.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
