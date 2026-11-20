#!/usr/bin/env python3
"""SessionStart hook: inject the most relevant stored memories for THIS agent
into a fresh session's context, so the agent does not have to remember to query
the memory API. Native build of the one pattern claude-mem does better than us
(Scout 7-package eval); see card `memory-sessionstart-autoinject`.

Mechanism mirrors the deterministic ledger replay: agent_id is derived from cwd
(so each session only loads its OWN warm + the fleet's shared memories), the
ranking/format policy lives in `memory_rank` (Applegate's design), and the hook
emits SessionStart additionalContext. Never breaks session start (always exit 0).

Injection policy (spec): inject on `startup` (cold start -- context is empty).
`resume` is intentionally NOT injected here: the hook cannot see whether the
resumed --continue context is empty, and re-injecting standing memories on a
warm resume would duplicate context. `clear` is a reset, not a memory-load.
The settings.json matcher (wiring PR) is `startup`; this in-hook guard is a
belt-and-suspenders so a mis-scoped matcher can never over-inject.
"""
import json
import os
import sqlite3
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ledger_lib  # noqa: E402  (reuse agent_id_from_cwd + store path)
import memory_rank  # noqa: E402

INJECT_SOURCES = {"startup"}

API = "http://localhost:3420/api"

HEADER = (
    "MEMÓRIA AUTO-INJECT (SessionStart). A munkád szempontjából legfontosabb "
    "tárolt emlékeid (warm = a sajátod, shared = flotta-kontextus), hogy ne kelljen "
    "kézzel keresned. Ezek akkori állapotot tükröznek, amikor leírtad őket: ha egy "
    "emlék fájlt, függvényt vagy flaget nevez meg, ellenőrizd hogy még létezik-e, "
    "mielőtt rá támaszkodsz."
)


def _db_path():
    override = os.environ.get("MEMORY_DB_PATH")
    return override if override else ledger_lib.db_path()


def _token():
    try:
        root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        with open(os.path.join(root, "store", ".dashboard-token"), "r") as f:
            return f.read().strip()
    except Exception:
        return ""


def _claim_budget(agent_id, chars):
    """Register chars with the cross-source continuity budget accumulator.
    Returns True iff allowed (or if the endpoint is unavailable -- fail-open).
    Fail-open: if the endpoint is unreachable the hook proceeds as before;
    the budget is a HARDENING layer, not a critical path gate."""
    token = _token()
    if not token:
        return True  # no token -> proceed (fail-open)
    try:
        data = json.dumps({"source": "memory", "chars": chars}).encode()
        req = urllib.request.Request(
            API + "/agent-continuity-budget/%s/claim" % agent_id,
            method="POST",
            data=data,
        )
        req.add_header("Authorization", "Bearer " + token)
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=3) as r:
            res = json.load(r)
            return (res or {}).get("allowed", True)
    except Exception:
        return True  # fail-open: proceed even if the endpoint is unreachable


def _candidates(agent_id):
    con = sqlite3.connect(_db_path(), timeout=10)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT content, topic_key, keywords, salience, accessed_at, created_at,"
            " agent_id, category FROM memories"
            " WHERE (category='warm' AND agent_id=?) OR category='shared'",
            (str(agent_id),),
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        con.close()


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

    agent_id = ledger_lib.agent_id_from_cwd(cwd)
    try:
        candidates = _candidates(agent_id)
    except Exception:
        sys.exit(0)  # memory store unavailable -> no-op, never break session start

    ranked = memory_rank.rank_memories(candidates, agent_id, k=5, split=(3, 2))
    if not ranked:
        sys.exit(0)  # nothing to inject

    block = memory_rank.format_block(ranked, int(time.time()))
    inject = HEADER + "\n\n" + block

    # HARD CROSS-SOURCE BUDGET CHECK: register with the combined continuity
    # accumulator before emitting. If the combined budget is exhausted (other
    # sources already claimed the full 8k), skip injection. Fail-open on network
    # errors so the endpoint is not a critical path gate.
    if agent_id and not _claim_budget(agent_id, len(inject)):
        sys.exit(0)  # budget exhausted -- skip to avoid over-injection

    out = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": inject,
        }
    }
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)


if __name__ == "__main__":
    main()
