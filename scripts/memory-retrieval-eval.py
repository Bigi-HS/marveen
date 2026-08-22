#!/usr/bin/env python3
"""Memory retrieval eval harness (card 570030c9, J1).

Measures whether the fleet memory system finds the RIGHT memory for a query.
Baseline metric: "lexical-anchor recall" -- for a deterministic sample of
memories, derive a query from that memory's own salient terms (keywords, else a
mid-content phrase) and check the rank of the source memory in the search
results. Reports recall@1/5/10 + MRR for hybrid (FTS5+vector) vs fts modes.

LIMITATION (honest): in the DEFAULT (lexical-anchor) mode the query is derived
from the target's own text, so it measures FINDABILITY-BY-OWN-TERMS, not
semantic paraphrase robustness. It is still a valid REGRESSION signal: if an
embedding/schema/rerank change breaks retrieval, recall drops -- and being
zero-dependency it can run every deploy.

A paraphrase-based eval now EXISTS as an opt-in mode (`--paraphrase`): instead of
reusing the memory's own terms it asks the fleet's LOCAL LLM (Ollama, loopback,
NO cloud credentials) for a short query in DIFFERENT words, so it measures
whether retrieval survives vocabulary mismatch -- the realistic case where a
future query does not reuse the memory's own wording. Honest caveat: paraphrase
quality (and therefore the reported numbers) depends on the local LLM; if Ollama
is unreachable the paraphrase mode degrades gracefully with a clear message
rather than crashing. The default lexical-anchor mode is unchanged and remains
the credential-free regression baseline.

REGRESSION MODE (card 570030c9, J1-final): the eval also speaks the fleet's
regression-gate interface (same shape as scripts/eval-notification-format.py) so
a deploy/CI check can consume it uniformly:
  --json        emit a machine-readable summary object to stdout (no human table)
  --threshold X pass-criteria is `hybrid recall@1 >= X` (hybrid is the PRODUCTION
                retrieval path). Exit code 0 when met, 1 when not.
The regression check runs the DEFAULT lexical-anchor mode (zero-dependency,
deterministic); paraphrase stays opt-in and is NOT the gate (LLM = slow/variable).

Usage: python3 scripts/memory-retrieval-eval.py [sample_N] [--paraphrase]
                                                 [--json] [--threshold X]
"""
import sqlite3, urllib.request, urllib.parse, json, sys, re, os

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.normpath(os.path.join(HERE, ".."))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from db_resolve import resolve_default_db  # noqa: E402

BASE = "http://localhost:3420"
_TOKEN_PATH = os.path.join(PROJECT_ROOT, "store", ".dashboard-token")


def _token():
    """Read the dashboard bearer token at USE time (not import time), so the pure
    query-generation helpers stay unit-testable without a live store present."""
    return open(_TOKEN_PATH).read().strip()


# Live DB (card 57480c07): honor NOA_DB_PATH, fail open to the live store/noa.db
# rather than the frozen legacy claudeclaw.db (this eval reads the memories table).
DB_PATH = resolve_default_db(project_root=PROJECT_ROOT)
KS = (1, 5, 10)

# Regression-gate default: the known baseline for the DEFAULT lexical-anchor mode
# has measured hybrid recall@1 = 0.97-1.00 on samples. 0.90 catches a real
# retrieval regression (embedding/schema/rerank break) while leaving headroom so
# a single unlucky sample row does not flake the gate. Overridable via --threshold.
DEFAULT_THRESHOLD = 0.90
STOP = set("a an the and or of to in on for with is are was the ez az es hogy nem "
           "egy mint van vagy mar meg csak ami amit ha de -- 07 06 2026".split())

# --- Paraphrase mode: fleet-local Ollama (loopback, ZERO cloud credentials) ---
# Mirrors the established local_worker.py convention: same daemon, same /api/chat
# contract, same think=false / format-JSON invariants, same loopback SSRF guard.
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
PARAPHRASE_MODEL = os.environ.get("EVAL_PARAPHRASE_MODEL", "qwen3:4b")
# Per-call paraphrase timeout (seconds). 120s was a heavy default for a small
# local model; 45s is enough for qwen3:4b on a warm daemon and fails faster on a
# stuck one. Override with EVAL_PARAPHRASE_TIMEOUT for slow hosts / larger models.
PARAPHRASE_TIMEOUT = float(os.environ.get("EVAL_PARAPHRASE_TIMEOUT", "45"))
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)

# NOTE: a small local model (qwen3:4b) tends to echo the instruction unless the
# task is shown concretely. Keep it example-driven and imperative: emit the query
# ITSELF, never a description of what a query should be.
PARAPHRASE_SYSTEM = (
    "Read the note, then write the SEARCH QUERY a person would type months later "
    "to find it again. Reply with the query and NOTHING else -- no preamble, no "
    "quotes, no explanation. Rules: 3 to 8 words; use DIFFERENT wording than the "
    "note (paraphrase the topic, never copy its exact technical terms); match the "
    "note's language (Hungarian note -> Hungarian query, else English).\n"
    "Example note: \"2026-05 the nightly backup cron silently failed because the "
    "disk was full, no alert fired\".\n"
    "Example query: missing warning when overnight save ran out of space"
)


def parse_cli(argv):
    """Split argv into (sample_N, paraphrase, as_json, threshold). Keeps the
    original positional sample arg and --paraphrase/-p opt-in; adds the fleet
    regression interface: --json (machine summary) and --threshold X (hybrid
    recall@1 pass-criteria). Default sample stays 40, threshold DEFAULT_THRESHOLD.
    Only recognised flags are honoured -- an unknown token is ignored, as before."""
    sample, paraphrase, as_json = 40, False, False
    threshold = DEFAULT_THRESHOLD
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--paraphrase", "-p"):
            paraphrase = True
        elif a in ("--lexical", "--anchor"):
            paraphrase = False
        elif a == "--json":
            as_json = True
        elif a == "--threshold":
            i += 1
            if i < len(argv):
                threshold = float(argv[i])
        elif a.startswith("--threshold="):
            threshold = float(a.split("=", 1)[1])
        elif a.lstrip("-").isdigit():
            sample = int(a.lstrip("-"))
        i += 1
    return sample, paraphrase, as_json, threshold


def search(q, mode, agent, limit=10):
    # search as the memory's OWNER agent -- otherwise another agent's non-shared
    # memory is structurally unreachable (correct isolation) and mis-counts as a
    # retrieval miss. Pass ?agent= so hybridSearch runs in the owner's scope.
    qs = urllib.parse.urlencode({"q": q, "mode": mode, "agent": agent, "limit": limit})
    req = urllib.request.Request(f"{BASE}/api/memories?{qs}",
                                 headers={"Authorization": f"Bearer {_token()}"})
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


def _assert_loopback(url):
    """SSRF/exfil guard (mirrors local_worker.assert_local_urls): the paraphrase
    prompt carries vault content, so the endpoint MUST be loopback -- a tampered
    OLLAMA_URL must not ship memory text to a remote host."""
    host = urllib.parse.urlparse(url).hostname
    if host not in LOCAL_HOSTS:
        raise RuntimeError(f"non-loopback OLLAMA_URL {url!r} (host={host!r}) -- abort (SSRF guard)")


def ollama_available(base_url=OLLAMA_URL, model=PARAPHRASE_MODEL,
                     opener=urllib.request.urlopen):
    """Is the local daemon up AND serving the paraphrase model? Returns False on
    any failure (no crash) so the caller can degrade gracefully."""
    try:
        _assert_loopback(base_url)
    except RuntimeError:
        raise
    try:
        with opener(f"{base_url}/api/tags", timeout=5) as r:
            tags = json.load(r)
    except Exception:
        return False
    family = model.split(":")[0]
    names = [m.get("name", "") for m in (tags or {}).get("models", [])]
    return any(model in n or family in n for n in names)


# A small local model sometimes returns a META-DESCRIPTION of the task ("a phrase
# that does not use the note's terms...") instead of the query itself. These
# tokens signal that; such an output is unusable as a query and is dropped (->
# the row is skipped, honestly excluded from the denominator).
_META_TOKENS = ("verbatim", "szakmai kifejezés", "search query", "keresési kifejezés",
                "the note", "a jegyzet", "3-8", "3–8", "paraphrase", "term")

# WHOLE-WORD matching (PR#389 nit): a bare substring test wrongly dropped a
# legitimate query word that merely CONTAINS a meta-token (e.g. 'terminal' -> the
# 'term' token, 'determine' -> 'term'). Anchor each token on word boundaries so
# only a standalone meta-token filters. Word chars include the accented Hungarian
# letters used in the multi-word Hungarian tokens; the digit-range tokens ("3-8",
# "3–8") keep their internal punctuation via re.escape.
_META_WORD = "[0-9A-Za-zÁÉÍÓÖŐÚÜŰáéíóöőúüű]"
_META_RE = re.compile(
    "|".join(rf"(?<!{_META_WORD})(?:{re.escape(tok)})(?!{_META_WORD})"
             for tok in _META_TOKENS),
    re.IGNORECASE,
)


def _clean_paraphrase(raw, max_words=12):
    """Strip qwen3 <think> blocks, quotes and trailing punctuation; return a
    single-line query. Returns '' if nothing usable remains OR the output is an
    over-long / meta-description echo rather than an actual query."""
    text = _THINK_RE.sub("", raw or "").strip()
    if not text:
        return ""
    # take the LAST non-empty line: a chatty model puts the answer last.
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    text = lines[-1] if lines else ""
    text = text.strip("\"'` ").rstrip(".!?,;:").strip()
    if _META_RE.search(text):  # standalone meta-token echo (whole-word) -> unusable
        return ""
    if len(text.split()) > max_words:  # not a short query -> unusable
        return ""
    return text


def paraphrase_query(row, base_url=OLLAMA_URL, model=PARAPHRASE_MODEL,
                     opener=urllib.request.urlopen):
    """Ask the LOCAL LLM for a short different-words query that a user might type
    to find this memory. Deterministic (temperature 0, seed fixed). Returns '' on
    any transport/parse failure so the row is skipped, never crashing the run."""
    _assert_loopback(base_url)
    content = (row["content"] or "").strip()
    if not content:
        return ""
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": PARAPHRASE_SYSTEM},
            {"role": "user", "content": f"Note:\n{content[:1200]}\n\nSearch query:"},
        ],
        "stream": False,
        "keep_alive": "10m",
        # temp 0 + fixed seed => as deterministic as the local model allows.
        "options": {"think": False, "temperature": 0, "seed": 7},
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/api/chat", data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with opener(req, timeout=PARAPHRASE_TIMEOUT) as r:
            resp = json.load(r)
    except Exception:
        return ""
    raw = (resp.get("message") or {}).get("content", "")
    return _clean_paraphrase(raw)


def rank_of(mem_id, results):
    for i, r in enumerate(results):
        if r.get("id") == mem_id:
            return i + 1
    return None


def run_eval(gen_query, sample_n):
    """Run the eval against the live server and return the raw tallies. Pure of
    any printing / exit; the caller shapes them for human or --json output.

    Returns a dict: {sample_size, evaluated, skipped, retrievable_total,
    stats{mode->{r@k,mrr_sum,found}}, misses{mode->[(id,q)]}, errors[str]}."""
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    # deterministic sample: every Nth by id, non-scoped (retrievable)
    rows = con.execute(
        "SELECT id, agent_id, content, keywords, category FROM memories "
        "WHERE (access_scope IS NULL OR access_scope='') ORDER BY id"
    ).fetchall()
    step = max(1, len(rows) // sample_n)
    sample = rows[::step][:sample_n]

    stats = {m: {f"r@{k}": 0 for k in KS} | {"mrr": 0.0, "found": 0}
             for m in ("hybrid", "fts")}
    misses = {"hybrid": [], "fts": []}
    errors = []

    evaluated = 0  # rows with a non-empty derived query -- the true recall denominator
    for row in sample:
        q = gen_query(row)
        if not q.strip():
            continue
        evaluated += 1
        for mode in ("hybrid", "fts"):
            try:
                res = search(q, mode, row["agent_id"], limit=10)
            except Exception as e:
                errors.append(f"{mode} q={q!r}: {e}")
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

    return {
        "sample_size": len(sample),
        "evaluated": evaluated,
        "skipped": len(sample) - evaluated,
        "retrievable_total": len(rows),
        "stats": stats,
        "misses": misses,
        "errors": errors,
    }


def build_summary(raw, mode_key, threshold):
    """Shape run_eval() tallies into the fleet regression-summary object (mirrors
    scripts/eval-notification-format.py: a `metrics` map + a `pass_criteria`
    {threshold, metric, value, met} block, gated on hybrid recall@1)."""
    n = raw["evaluated"]
    metrics = {}
    for mode in ("hybrid", "fts"):
        s = raw["stats"][mode]
        metrics[mode] = {
            **{f"recall@{k}": round(s[f"r@{k}"] / n, 4) if n else None for k in KS},
            "mrr": round(s["mrr"] / n, 4) if n else None,
            "found": s["found"],
        }
    hybrid_r1 = metrics["hybrid"]["recall@1"]
    met = hybrid_r1 is not None and hybrid_r1 >= threshold
    return {
        "experiment_id": "memory-retrieval-eval",
        "mode": mode_key,
        "sample_size": raw["sample_size"],
        "evaluated": n,
        "skipped": raw["skipped"],
        "retrievable_total": raw["retrievable_total"],
        "metrics": metrics,
        "pass_criteria": {
            "metric": "hybrid recall@1",
            "threshold": threshold,
            "value": hybrid_r1,
            "met": met,
        },
        "errors": raw["errors"],
    }


def main(argv=None):
    sample_n, paraphrase, as_json, threshold = parse_cli(
        sys.argv[1:] if argv is None else argv)

    # Only the query generator is swappable -- metrics/reporting are shared.
    if paraphrase:
        # Graceful degrade: no local LLM -> clear message + skip, never crash.
        # NOTE: paraphrase is opt-in and NEVER the regression gate (LLM =
        # slow/variable); the deploy/CI check runs the default lexical-anchor mode.
        if not ollama_available():
            msg = ("the local LLM is unreachable: Ollama at "
                   f"{OLLAMA_URL} did not serve model {PARAPHRASE_MODEL!r}")
            if as_json:
                print(json.dumps({"experiment_id": "memory-retrieval-eval",
                                  "mode": "paraphrase", "skipped_run": True,
                                  "reason": msg}, ensure_ascii=False))
            else:
                print("# Memory retrieval eval (paraphrase mode) -- SKIPPED: "
                      f"{msg}.\n"
                      "#   Paraphrase mode needs the fleet-local daemon (no cloud "
                      "credentials); start it and retry,\n"
                      "#   or run the default lexical-anchor baseline: "
                      "python3 scripts/memory-retrieval-eval.py")
            # Not a regression FAIL -- the gate never runs paraphrase. Exit 0.
            return 0
        gen_query = paraphrase_query
        mode_key = "paraphrase"
        mode_label = f"paraphrase (LLM: {PARAPHRASE_MODEL} via local Ollama)"
    else:
        gen_query = make_query
        mode_key = "lexical-anchor"
        mode_label = "lexical-anchor (baseline, zero-dependency)"

    raw = run_eval(gen_query, sample_n)

    if raw["evaluated"] == 0:
        summary = build_summary(raw, mode_key, threshold)
        if as_json:
            print(json.dumps(summary, indent=2, ensure_ascii=False))
        else:
            print(f"# Memory retrieval eval [{mode_label}] -- no evaluable memories "
                  f"(sample={raw['sample_size']}, all had empty derived queries or "
                  "table empty)")
        # No data => cannot assert the pass-criteria => regression FAIL (exit 1).
        return 1

    summary = build_summary(raw, mode_key, threshold)
    met = summary["pass_criteria"]["met"]

    if as_json:
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return 0 if met else 1

    # --- human table (unchanged baseline signal + appended verdict line) ---
    n = raw["evaluated"]
    empty_note = "empty paraphrase" if paraphrase else "empty query"
    note = f", {raw['skipped']} skipped ({empty_note})" if raw["skipped"] else ""
    print(f"# Memory retrieval eval [{mode_label}]\n"
          f"# evaluated={n} (of {raw['retrievable_total']} retrievable{note})\n")
    for mode in ("hybrid", "fts"):
        s = raw["stats"][mode]
        line = "  ".join(f"recall@{k}={s[f'r@{k}']/n:.2f}" for k in KS)
        print(f"[{mode:6}] {line}  MRR={s['mrr']/n:.3f}  found={s['found']}/{n}")
    print()
    if raw["errors"]:
        print(f"errors ({len(raw['errors'])}), first 5:")
        for e in raw["errors"][:5]:
            print(f"  ERR {e}")
        print()
    # show a few hybrid misses for inspection
    if raw["misses"]["hybrid"]:
        print(f"hybrid misses ({len(raw['misses']['hybrid'])}), first 5:")
        for mid, q in raw["misses"]["hybrid"][:5]:
            print(f"  id={mid} q={q!r}")
        print()
    # regression verdict (the gate-consumable line)
    pc = summary["pass_criteria"]
    verdict = "PASS" if met else "FAIL"
    print(f"regression: {verdict}  ({pc['metric']}={pc['value']:.2f} "
          f">= threshold {pc['threshold']:.2f} => {'MET' if met else 'NOT MET'})")
    return 0 if met else 1


if __name__ == "__main__":
    sys.exit(main())
