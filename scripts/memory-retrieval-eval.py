#!/usr/bin/env python3
"""Memory retrieval eval harness (card 570030c9, J1).

Measures whether the fleet memory system finds the RIGHT memory for a query.
Baseline metric: "lexical-anchor recall" -- for a deterministic sample of
memories, derive a query from that memory's own salient terms (keywords, else a
mid-content phrase) and check the rank of the source memory in the search
results. Reports recall@1/5/10 + MRR for hybrid (FTS5+vector) vs fts modes.

LIMITATION (honest): the query is derived from the target's own text, so this
measures FINDABILITY-BY-OWN-TERMS, not semantic paraphrase robustness. It is
still a valid REGRESSION signal: if an embedding/schema/rerank change breaks
retrieval, recall drops. A paraphrase-based eval (LLM-generated queries) is the
next iteration; this is the zero-dependency baseline that can run every deploy.

Usage: python3 scripts/memory-retrieval-eval.py [sample_N]
"""
import sqlite3, urllib.request, urllib.parse, json, sys, re

BASE = "http://localhost:3420"
TOK = open("store/.dashboard-token").read().strip()
SAMPLE = int(sys.argv[1]) if len(sys.argv) > 1 else 40
KS = (1, 5, 10)
STOP = set("a an the and or of to in on for with is are was the ez az es hogy nem "
           "egy mint van vagy mar meg csak ami amit ha de -- 07 06 2026".split())


def search(q, mode, agent, limit=10):
    # search as the memory's OWNER agent -- otherwise another agent's non-shared
    # memory is structurally unreachable (correct isolation) and mis-counts as a
    # retrieval miss. Pass ?agent= so hybridSearch runs in the owner's scope.
    qs = urllib.parse.urlencode({"q": q, "mode": mode, "agent": agent, "limit": limit})
    req = urllib.request.Request(f"{BASE}/api/memories?{qs}",
                                 headers={"Authorization": f"Bearer {TOK}"})
    return json.load(urllib.request.urlopen(req, timeout=20))


def make_query(row):
    """Derive a query from the memory's own salient terms."""
    kw = (row["keywords"] or "").replace(",", " ").split()
    kw = [w for w in kw if len(w) > 3 and w.lower() not in STOP]
    if len(kw) >= 3:
        return " ".join(kw[:5])
    # fallback: salient words from content (skip leading label/date)
    words = re.findall(r"[A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű0-9]+", row["content"] or "")
    words = [w for w in words if len(w) > 4 and w.lower() not in STOP]
    return " ".join(words[:6])


def rank_of(mem_id, results):
    for i, r in enumerate(results):
        if r.get("id") == mem_id:
            return i + 1
    return None


def main():
    con = sqlite3.connect("store/noa.db")
    con.row_factory = sqlite3.Row
    # deterministic sample: every Nth by id, non-scoped (retrievable)
    rows = con.execute(
        "SELECT id, agent_id, content, keywords, category FROM memories "
        "WHERE (access_scope IS NULL OR access_scope='') ORDER BY id"
    ).fetchall()
    step = max(1, len(rows) // SAMPLE)
    sample = rows[::step][:SAMPLE]

    stats = {m: {f"r@{k}": 0 for k in KS} | {"mrr": 0.0, "found": 0}
             for m in ("hybrid", "fts")}
    misses = {"hybrid": [], "fts": []}

    for row in sample:
        q = make_query(row)
        if not q.strip():
            continue
        for mode in ("hybrid", "fts"):
            try:
                res = search(q, mode, row["agent_id"], limit=10)
            except Exception as e:
                print(f"  ERR {mode} q={q!r}: {e}")
                continue
            rank = rank_of(row["id"], res)
            if rank:
                stats[mode]["found"] += 1
                stats[mode]["mrr"] += 1.0 / rank
                for k in KS:
                    if rank <= k:
                        stats[mode][f"r@{k}"] += 1
            else:
                misses[mode].append((row["id"], q))

    n = len(sample)
    print(f"# Memory retrieval eval -- sample={n} (of {len(rows)} retrievable)\n")
    for mode in ("hybrid", "fts"):
        s = stats[mode]
        line = "  ".join(f"recall@{k}={s[f'r@{k}']/n:.2f}" for k in KS)
        print(f"[{mode:6}] {line}  MRR={s['mrr']/n:.3f}  found={s['found']}/{n}")
    print()
    # show a few hybrid misses for inspection
    if misses["hybrid"]:
        print(f"hybrid misses ({len(misses['hybrid'])}), first 5:")
        for mid, q in misses["hybrid"][:5]:
            print(f"  id={mid} q={q!r}")


if __name__ == "__main__":
    main()
