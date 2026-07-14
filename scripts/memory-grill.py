#!/usr/bin/env python3
"""Proactive "grill-me" memory extraction (card 570030c9, J2).

Counters G2 (passive save / marveen-concentration): instead of waiting for an
agent to document itself, each agent SELF-GRILLS -- answers a role-specific
question bank that pulls implicit knowledge, then pipes the answers here to be
deduped against the existing vault and filed by tier.

Two modes:
  --questions <agent>            print the interview (common + role bank) and an
                                 answers.json skeleton to fill in.
  --ingest <agent> <answers.json> [--dry-run]
                                 dedup each candidate against the agent's vault
                                 and write the novel ones via POST /api/memories.

DEDUP: novelty is measured by EMBEDDING cosine, not lexical overlap -- the vault
is Hungarian-dominant while grill answers are often English, so token-overlap
cannot bridge the language/paraphrase gap (verified: a correct near-duplicate
scored 0.13 Jaccard). The memories table stores each row's nomic-embed-text
vector (768-dim float32 BLOB); we embed the candidate via the same localhost
ollama model and cosine it against the agent's own + shared vectors.

CALIBRATION (measured, nomic-embed-text): exact re-embed of a stored memory
scores ~1.00, a same-language SEMANTIC paraphrase of the same fact only ~0.70,
and an unrelated same-language memory ~0.52. The model is NOT strongly
paraphrase-invariant, so a single threshold cannot separate "paraphrased dup"
(0.70) from "related-but-novel" (0.65). We therefore use two bands:
  cosine >= COS_DUP (0.88)      -> near-verbatim duplicate, auto-SKIP
  COS_REVIEW..COS_DUP (0.72-0.88) -> possible dup, FLAG for human review (not
                                   auto-written), naming the closest memory
  cosine <  COS_REVIEW (0.72)   -> novel, written (or shown on --dry-run)
Every decision prints the score + matched id so the grilled agent can override.
If ollama is unreachable the script falls back to a single lexical threshold.

GOVERNANCE: writes use agent_id=<agent> (the self-grilling agent). An agent must
not write into another agent's scope -- run this as the agent being grilled. The
server's resolveAccessScope still auto-scopes PII and rejects scoped+shared.

Usage:
  python3 scripts/memory-grill.py --questions marveen
  python3 scripts/memory-grill.py --ingest marveen /tmp/answers.json --dry-run
"""
import sys, os, json, re, math, struct, sqlite3, urllib.request, urllib.parse

BASE = "http://localhost:3420"
OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "nomic-embed-text")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
TOK = open(os.path.join(ROOT, "store", ".dashboard-token")).read().strip()
DB = os.path.join(ROOT, "store", "noa.db")


def _resolve_templates():
    """Templates ship tracked next to this script. Resolution order:
      1. $GRILL_TEMPLATES (explicit operator override)
      2. store/grill-templates.json (untracked operator customization, if present)
      3. scripts/grill-templates.json (the tracked default that ships) -- resolved
         relative to this file so it works from any CWD.
    """
    env = os.environ.get("GRILL_TEMPLATES")
    if env:
        return env
    store_override = os.path.join(ROOT, "store", "grill-templates.json")
    if os.path.exists(store_override):
        return store_override
    return os.path.join(SCRIPT_DIR, "grill-templates.json")


TEMPLATES = _resolve_templates()
COS_DUP = 0.88     # cosine at/above which a candidate is a near-verbatim duplicate
COS_REVIEW = 0.72  # cosine band [COS_REVIEW, COS_DUP) -> flag for human review
THRESHOLD = 0.45   # lexical-overlap fallback threshold (ollama unreachable)
VALID_TIERS = {"hot", "warm", "cold", "shared"}
STOP = set("a an the and or of to in on for with is are was ez az es hogy nem egy "
           "mint van vagy mar meg csak ami amit ha de you your what which how when "
           "that this not do does most often into out via per not never must".split())

_ACC = str.maketrans("áéíóöőúüűÁÉÍÓÖŐÚÜŰ", "aeiooouuuaeiooouuu")


def deaccent(s):
    return (s or "").translate(_ACC).lower()


def tokens(s):
    return {w for w in re.findall(r"[a-z0-9]+", deaccent(s)) if len(w) > 3 and w not in STOP}


def load_templates():
    with open(TEMPLATES) as f:
        return json.load(f)


def bank_for(agent):
    t = load_templates()
    return t["common"] + t["roles"].get(agent, [])


def cmd_questions(agent):
    bank = bank_for(agent)
    print(f"# Grill-me interview -- {agent} ({len(bank)} questions)\n")
    skeleton = []
    for i, item in enumerate(bank, 1):
        print(f"{i:2}. [{item['tier_hint']:6}] ({item['id']}) {item['q']}")
        skeleton.append({"qid": item["id"], "tier_hint": item["tier_hint"],
                         "content": "", "keywords": ""})
    print("\n# answers.json skeleton (fill 'content'; keep only the ones you can answer):")
    print(json.dumps(skeleton, ensure_ascii=False, indent=2))


def embed(text):
    """Embed via the same localhost ollama model the server uses. None on failure."""
    body = json.dumps({"model": EMBED_MODEL, "prompt": text}).encode()
    req = urllib.request.Request(f"{OLLAMA}/api/embeddings", data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        data = json.load(urllib.request.urlopen(req, timeout=30))
        v = data.get("embedding")
        return v if v else None
    except Exception as e:
        print(f"   ! embed error ({EMBED_MODEL}): {e}", file=sys.stderr)
        return None


def load_vault_vectors(agent):
    """(id, content, vec[]) for the agent's own + shared memories that have a vector."""
    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT id, content, embedding FROM memories "
        "WHERE (agent_id = ? OR category = 'shared') AND embedding IS NOT NULL",
        (agent,)).fetchall()
    out = []
    for mid, content, blob in rows:
        n = len(blob) // 4
        out.append((mid, content, struct.unpack(f"<{n}f", blob)))
    return out


def cosine(a, b):
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def best_cosine(vec, vault):
    best = (0.0, None, "")
    for mid, content, mv in vault:
        c = cosine(vec, mv)
        if c > best[0]:
            best = (c, mid, (content or "")[:70])
    return best


def search(q, agent, limit=8):
    qs = urllib.parse.urlencode({"q": q, "mode": "hybrid", "agent": agent, "limit": limit})
    req = urllib.request.Request(f"{BASE}/api/memories?{qs}",
                                 headers={"Authorization": f"Bearer {TOK}"})
    return json.load(urllib.request.urlopen(req, timeout=20))


def best_overlap(cand_tokens, agent):
    """Lexical fallback: (max_jaccard, matched_id, snippet) vs the vault."""
    q = " ".join(list(cand_tokens)[:6])
    if not q.strip():
        return 0.0, None, ""
    try:
        results = search(q, agent)
    except Exception as e:
        print(f"   ! search error: {e}", file=sys.stderr)
        return 0.0, None, ""
    best = (0.0, None, "")
    for r in results:
        rt = tokens((r.get("content") or "") + " " + (r.get("keywords") or ""))
        if not rt:
            continue
        j = len(cand_tokens & rt) / len(cand_tokens | rt)
        if j > best[0]:
            best = (j, r.get("id"), (r.get("content") or "")[:70])
    return best


def write_memory(agent, content, category, keywords):
    body = json.dumps({"agent_id": agent, "content": content,
                       "category": category, "keywords": keywords or None}).encode()
    req = urllib.request.Request(f"{BASE}/api/memories", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {TOK}",
                                          "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=20))


def cmd_ingest(agent, path, dry):
    answers = json.load(open(path))
    vault = load_vault_vectors(agent)
    use_embed = embed("dedup probe") is not None
    metric = f"cosine dup>={COS_DUP} review>={COS_REVIEW}" if use_embed \
        else f"lexical>={THRESHOLD} (ollama down)"
    new, review, dup, written = [], [], [], 0
    print(f"# Grill ingest -- {agent} ({len(answers)} candidates)  dry_run={dry}  "
          f"vault={len(vault)}  dedup={metric}\n")
    for a in answers:
        content = (a.get("content") or "").strip()
        if not content:
            continue
        category = (a.get("tier_hint") or a.get("category") or "warm").lower()
        if category not in VALID_TIERS:
            category = "warm"
        keywords = a.get("keywords") or ""
        text = content + (" " + keywords if keywords else "")
        if use_embed:
            vec = embed(text)
            score, mid, snip = best_cosine(vec, vault) if vec else (0.0, None, "")
            dup_hi, review_hi = COS_DUP, COS_REVIEW
        else:
            score, mid, snip = best_overlap(tokens(text), agent)
            dup_hi, review_hi = THRESHOLD, THRESHOLD  # fallback: single threshold
        if score >= dup_hi:
            dup.append((a.get("qid"), score, mid))
            print(f"  SKIP   ({a.get('qid')}) {score:.3f} ~ #{mid} \"{snip}\"")
        elif score >= review_hi:
            review.append((a.get("qid"), score, mid))
            print(f"  REVIEW ({a.get('qid')}) [{category}] {score:.3f} ~ #{mid} \"{snip}\"  candidate: \"{content[:50]}\"")
        else:
            new.append(a)
            if dry:
                print(f"  NEW    ({a.get('qid')}) [{category}] best={score:.3f}  \"{content[:52]}\"")
            else:
                r = write_memory(agent, content, category, keywords)
                written += 1
                print(f"  WROTE  ({a.get('qid')}) [{category}] id={r.get('id')}  \"{content[:48]}\"")
    tail = f", {written} written" if not dry else " (dry-run, nothing written)"
    print(f"\n# {len(new)} novel, {len(review)} to-review, {len(dup)} duplicate{tail}")
    if review:
        print("# REVIEW items are NOT auto-written: the grilled agent confirms or drops each.")


def main():
    args = sys.argv[1:]
    if len(args) >= 2 and args[0] == "--questions":
        cmd_questions(args[1])
    elif len(args) >= 3 and args[0] == "--ingest":
        cmd_ingest(args[1], args[2], "--dry-run" in args)
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
