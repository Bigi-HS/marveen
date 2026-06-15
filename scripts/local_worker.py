#!/usr/bin/env python3
"""PATH B local-worker poller -- advisory memory-tiering (card 6006f513).

A standalone, stdlib-only poller that talks DIRECTLY to Ollama over HTTP (no
Claude Code harness, no system-prompt/tool-schema overhead -- so a small local
model like qwen3:4b can handle it) and is ZERO cloud-token by construction.

MVP scope = ADVISORY only: the poller reads memories from the fleet dashboard
API, asks Ollama to classify each into a tier (hot/warm/cold/shared), and writes
a SUGGESTION to store/local_worker_suggestions.jsonl alongside the memory's
current category. It NEVER writes the category back to the DB -- Applegate
reviews the divergences; the authoritative write-path is a separate gated step
after an accuracy baseline. See store/ollama-pathb-spec.md (v2).

Daemon lifecycle: `scripts/lib/ollama-local-guard.sh` owns starting `ollama
serve` (fleet-boot / fleet-supervisor). This poller's pre-call health-check makes
it safe when Ollama is down -- it no-ops the cycle, never crashes, never falls
back to a cloud model.

The executable lives in scripts/ (tracked); its runtime artifacts -- the
suggestions jsonl and the run log -- live under store/ (gitignored data).

Run (one cycle, e.g. the Buster-c12 smoke):  python3 scripts/local_worker.py --once
Run (continuous 30s poller):                 python3 scripts/local_worker.py
Launch with NO cloud credentials in the env (or explicit ANTHROPIC_API_KEY="").
"""
import argparse
import json
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request

# --- configuration -----------------------------------------------------------

VALID_CATEGORIES = {"hot", "warm", "cold", "shared"}
THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)

DEFAULT_OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
DEFAULT_DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "http://localhost:3420")
DEFAULT_MODEL = os.environ.get("LOCAL_WORKER_MODEL", "qwen3:4b")
DEFAULT_AGENT = os.environ.get("LOCAL_WORKER_AGENT", "marveen")
DEFAULT_INTERVAL = int(os.environ.get("LOCAL_WORKER_INTERVAL", "30"))
KEEP_ALIVE = "10m"
BURST_CAP = 10            # max ollama calls per cycle -- avoids a VRAM burst
FETCH_LIMIT = 200         # max memories pulled per cycle (API hard cap)

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUGGESTIONS_PATH = os.path.join(_REPO_ROOT, "store", "local_worker_suggestions.jsonl")
LOG_PATH = os.path.join(_REPO_ROOT, "store", "local_worker.log")
TOKEN_PATH = os.path.join(_REPO_ROOT, "store", ".dashboard-token")

SYSTEM_PROMPT = (
    "You are a memory classifier. "
    "Given a memory entry, return JSON with one key: 'category'. "
    "Valid values: hot, warm, cold, shared. "
    "hot=currently active task; warm=stable config/preference; "
    "cold=long-term lesson/archive; shared=relevant to multiple agents. "
    "Return ONLY valid JSON, nothing else."
)


# --- pure functions (unit-tested) --------------------------------------------

# Cloud credentials that must be scrubbed from the launch env. Scoped to the
# actual exfil-capable tokens (NOT a blanket CLAUDE_* -- CLAUDE_CONFIG_DIR is a
# benign path set fleet-wide and must not trip the fuse).
CLOUD_CRED_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")

# Hosts the poller is allowed to talk to. It reads the whole vault, so both
# endpoints must be loopback -- a tampered env must not exfiltrate to a remote.
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def assert_no_cloud_credentials(env):
    """Mandatory cloud-token fuse. Raise if a non-empty cloud credential is set.

    PATH B must NEVER reach a cloud model. An explicit empty override
    (ANTHROPIC_API_KEY="") is the documented safe launch form, so only a
    truthy value aborts. The launcher is expected to start the poller with these
    unset/empty.
    """
    for var in CLOUD_CRED_VARS:
        if env.get(var):
            raise RuntimeError(
                f"PATH B: cloud credential {var} detected -- abort. Use Ollama only."
            )


def assert_local_urls(*urls):
    """SSRF/exfil fuse (Chad A10): every endpoint host MUST be loopback.

    Guards against a prompt-injected agent or compromised supervisor rewriting
    OLLAMA_URL/DASHBOARD_URL to ship vault content to a remote. Exact host match
    (so "localhost.evil.com" is rejected, not prefix-matched).
    """
    for u in urls:
        host = urllib.parse.urlparse(u).hostname
        if host not in LOCAL_HOSTS:
            raise RuntimeError(
                f"PATH B: non-loopback endpoint {u!r} (host={host!r}) -- abort (SSRF guard)."
            )


def parse_category(raw):
    """Strip qwen3 <think> blocks, parse the JSON, return a valid tier or None.

    Double net: the request already sets think=false + format=json, but a stray
    <think> block or non-JSON noise must degrade to None (-> PARSE_FAIL), never
    crash and never produce an out-of-vocabulary category.
    """
    cleaned = THINK_RE.sub("", raw or "").strip()
    try:
        obj = json.loads(cleaned)
        cat = obj.get("category")
        if not isinstance(cat, str):
            return None
        cat = cat.strip().lower()
        return cat if cat in VALID_CATEGORIES else None
    except (json.JSONDecodeError, AttributeError, TypeError):
        return None


def build_classify_payload(entry, model):
    """Build the Ollama /api/chat request body for one memory entry.

    Invariants: stream off, format=json, keep_alive set (avoid cold reload),
    options.think=False (qwen3 thinking-mode would pollute the structured output).
    """
    keywords = entry.get("keywords", "") or ""
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Memory: {entry['content']}\nKeywords: {keywords}"},
        ],
        "stream": False,
        "format": "json",
        "keep_alive": KEEP_ALIVE,
        "options": {"think": False},
    }


def tags_have_model(tags, model):
    """Pure core of the health check: does GET /api/tags serve `model`?

    Substring match on the model family (so a quantised qwen3:4b-instruct-q4_k_m
    tag satisfies a qwen3:4b requirement).
    """
    family = model.split(":")[0]
    names = [m.get("name", "") for m in (tags or {}).get("models", [])]
    return any(model in n or family in n for n in names)


def select_pending(memories, already, cap, rng):
    """Pick up to `cap` memories not yet in the suggestions log.

    GAP1 (Thor): because advisory mode never writes the category back, the API
    keeps returning the same pool every cycle. Without shuffling, the poller
    would re-classify the same first `cap` items forever and starve the tail.
    Shuffle the pending set BEFORE capping -> probabilistic full coverage across
    cycles.
    """
    pending = [m for m in memories if m["id"] not in already]
    rng.shuffle(pending)
    return pending[:cap]


def make_suggestion_record(entry, suggested, raw, now):
    """Build one advisory jsonl record.

    Logs the model's suggestion ALONGSIDE the memory's current category so
    Applegate can review divergences (the real advisory signal). On a parse
    failure, suggested_category is the explicit "PARSE_FAIL" marker.
    """
    return {
        "ts": now,
        "memory_id": entry["id"],
        "content_preview": (entry.get("content") or "")[:80],
        "current_category": entry.get("category"),
        "suggested_category": suggested or "PARSE_FAIL",
        "raw_response": (raw or "")[:200],
    }


# --- IO helpers ---------------------------------------------------------------

def _log(msg):
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}"
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass
    print(line, file=sys.stderr)


def _read_token():
    try:
        with open(TOKEN_PATH, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def ollama_ready(base_url, model, retries=3, wait=10, opener=urllib.request.urlopen):
    """Live pre-call health check: is the daemon up AND serving the model?

    Returns False (no crash) on any failure -- the cycle is then skipped and
    ollama-local-guard.sh is responsible for (re)starting the daemon.
    """
    for attempt in range(retries):
        try:
            with opener(f"{base_url}/api/tags", timeout=5) as r:
                tags = json.load(r)
            if tags_have_model(tags, model):
                return True
        except Exception:
            pass
        if attempt < retries - 1:
            time.sleep(wait)
    return False


def fetch_memories(base_url, agent, token, opener=urllib.request.urlopen):
    """GET /api/memories?agent=<agent>&limit=N -> list of memory dicts."""
    url = f"{base_url}/api/memories?agent={agent}&limit={FETCH_LIMIT}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with opener(req, timeout=10) as r:
        return json.load(r)


def load_already_suggested(path):
    """Read the suggestions jsonl and return the set of memory_ids already seen."""
    seen = set()
    if not os.path.exists(path):
        return seen
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    seen.add(json.loads(line)["memory_id"])
                except (json.JSONDecodeError, KeyError):
                    continue
    except OSError:
        pass
    return seen


def append_suggestion(path, record):
    # 0600: the jsonl holds vault-derived content previews (Chad). Create with
    # owner-only perms and enforce them even if the file pre-exists looser.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def classify_one(entry, model, base_url, opener=urllib.request.urlopen):
    """POST one memory to Ollama /api/chat -> (suggested_category|None, raw_text)."""
    payload = json.dumps(build_classify_payload(entry, model)).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/api/chat", data=payload,
        headers={"Content-Type": "application/json"},
    )
    with opener(req, timeout=120) as r:
        resp = json.load(r)
    raw = (resp.get("message") or {}).get("content", "")
    return parse_category(raw), raw


# --- orchestration ------------------------------------------------------------

def run_cycle(ollama_url, dashboard_url, model, agent, token, rng,
              health_retries=3, health_wait=10):
    """One advisory pass. Returns a summary dict (also used by the smoke test)."""
    if not ollama_ready(ollama_url, model, retries=health_retries, wait=health_wait):
        _log("ollama not ready -- cycle skipped (no-op, no cloud fallback)")
        return {"skipped": True, "suggested": 0, "parse_fail": 0}

    memories = fetch_memories(dashboard_url, agent, token)
    already = load_already_suggested(SUGGESTIONS_PATH)
    pending = select_pending(memories, already, cap=BURST_CAP, rng=rng)

    suggested = parse_fail = 0
    for entry in pending:
        try:
            cat, raw = classify_one(entry, model, ollama_url)
        except Exception as e:  # network/parse error on a single item -> safe default
            cat, raw = None, f"ERROR: {e}"
        record = make_suggestion_record(entry, cat, raw, time.time())
        append_suggestion(SUGGESTIONS_PATH, record)
        if cat:
            suggested += 1
        else:
            parse_fail += 1

    _log(f"cycle done: {len(memories)} memories, {len(pending)} classified, "
         f"{suggested} suggested, {parse_fail} parse_fail")
    return {"skipped": False, "suggested": suggested, "parse_fail": parse_fail}


def main(argv=None):
    parser = argparse.ArgumentParser(description="PATH B advisory memory-tiering poller")
    parser.add_argument("--once", action="store_true", help="run a single cycle and exit")
    parser.add_argument("--interval", type=int, default=DEFAULT_INTERVAL)
    parser.add_argument("--ollama-url", default=DEFAULT_OLLAMA_URL)
    parser.add_argument("--dashboard-url", default=DEFAULT_DASHBOARD_URL)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--agent", default=DEFAULT_AGENT)
    args = parser.parse_args(argv)

    assert_no_cloud_credentials(os.environ)            # fail-fast before any work
    assert_local_urls(args.ollama_url, args.dashboard_url)  # SSRF/exfil guard

    token = _read_token()
    rng = random.Random()
    _log(f"local_worker start (model={args.model}, agent={args.agent}, "
         f"once={args.once}, interval={args.interval}s)")

    while True:
        try:
            run_cycle(args.ollama_url, args.dashboard_url, args.model, args.agent, token, rng)
        except Exception as e:  # a cycle-level failure must not kill the poller
            _log(f"cycle error: {e}")
        if args.once:
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
