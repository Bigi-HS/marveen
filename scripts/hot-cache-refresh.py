#!/usr/bin/env python3
"""Auto-refresh per-agent hot-cache.md from the deterministic ledger + kanban
(card fedb4b5f Phase 2).

The SessionStart hook (hot-cache-sessionstart.py) injects each agent's
.claude/hot-cache.md as a "current" snapshot. Phase 1 added a staleness-guard so
a frozen cache stops anchoring the agent. Phase 2 (this script) keeps the cache
from freezing in the first place: it regenerates the snapshot from sources that
CAN'T go stale -- the agent's in_progress kanban cards (the work) plus its most
recent ledger turn (the conversation) -- so the hook always reads a fresh file
and the staleness-guard stays a backstop, not the normal path.

Layering / sources (deliberately split, mirrors the live data layout):
  - kanban in_progress: noa.db (NOA_DB_PATH)        -> the agent's active work
  - ledger recent:      claudeclaw.db (ledger_lib)  -> the agent's last turn

Each agent only ever reads its OWN assigned cards + its OWN ledger and writes its
OWN cache -- no cross-agent data flow.

Self-throttling: the script is safe to call every fleet-supervisor tick. It skips
an agent whose cache was written less than REFRESH_INTERVAL_SECONDS ago (mtime),
so the supervisor can call it unconditionally (idempotent). A missing/old cache
is regenerated; --force bypasses the throttle.

Test overrides: NOA_DB_PATH, LEDGER_DB_PATH (honoured by ledger_lib),
HOT_CACHE_INSTALL_DIR (write root), HOT_CACHE_REFRESH_SECONDS (throttle),
MAIN_AGENT_ID (which agent writes to <install>/.claude vs agents/<id>/.claude).
"""
import json
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks"))
import ledger_lib  # noqa: E402

# Channel agents that benefit from a maintained snapshot (card fedb4b5f).
CHANNEL_AGENTS = ["marveen", "claudia", "hibiki", "bond", "bigben", "scout", "dave"]

# Regenerate at most this often per agent (mtime throttle). 4h << the hook's 24h
# stale threshold, so a healthy refresher keeps every cache well inside "fresh".
REFRESH_INTERVAL_SECONDS = int(os.environ.get("HOT_CACHE_REFRESH_SECONDS", 4 * 3600))

MAX_CARDS = 6
TITLE_CHARS = 100
INBOUND_SNIPPET_CHARS = 200
# Stay under the hook's CONTENT_CHAR_LIMIT (2000) so a full inject is never truncated.
CONTENT_CHAR_LIMIT = 1800


def _install_dir() -> str:
    override = os.environ.get("HOT_CACHE_INSTALL_DIR")
    if override:
        return override
    here = os.path.dirname(os.path.abspath(__file__))  # <install>/scripts
    return os.path.dirname(here)


def _noa_db_path(install_dir: str) -> str:
    def _resolve(v: str) -> str:
        return v if os.path.isabs(v) else os.path.join(install_dir, v)

    override = os.environ.get("NOA_DB_PATH")
    if override:
        return _resolve(override)
    try:
        with open(os.path.join(install_dir, ".env")) as f:
            for line in f:
                if line.startswith("NOA_DB_PATH="):
                    return _resolve(line.split("=", 1)[1].strip())
    except Exception:
        pass
    return os.path.join(install_dir, "store", "noa.db")


def _hot_cache_path(agent_id: str, install_dir: str) -> Path:
    if agent_id == ledger_lib.main_agent_id():
        return Path(install_dir) / ".claude" / "hot-cache.md"
    return Path(install_dir) / "agents" / agent_id / ".claude" / "hot-cache.md"


def _load_in_progress(agent_id: str, noa_db_path: str):
    """The agent's in_progress cards (highest priority first). Read-only; any
    failure (missing DB, schema drift) degrades to an empty list, never raises."""
    try:
        con = sqlite3.connect(f"file:{noa_db_path}?mode=ro", uri=True, timeout=5)
    except Exception:
        return []
    try:
        rows = con.execute(
            "SELECT id, title, priority FROM kanban_cards"
            " WHERE assignee = ? AND status = 'in_progress'"
            " ORDER BY priority_score ASC, id ASC LIMIT ?",
            (agent_id, MAX_CARDS),
        ).fetchall()
        return [(r[0], r[1], r[2]) for r in rows]
    except Exception:
        return []
    finally:
        con.close()


def _last_inbound(agent_id: str):
    """The agent's most recent inbound ledger turn as (text, ts), or None."""
    try:
        turns = ledger_lib.recent(agent_id)  # (direction, chat_id, text, ts), oldest-first
        for direction, _chat_id, text, ts in reversed(turns):
            if direction == "in" and text:
                return (text, ts)
    except Exception:
        pass
    return None


def build_hot_cache(agent_id: str, cards, last_inbound, now: float) -> str:
    """Pure: render the snapshot markdown from the agent's cards + last turn."""
    lines = [f"# {agent_id} — Hot Cache"]
    stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(now))
    lines.append(f"_auto · frissítve {stamp} · forrás: kanban in_progress + ledger_")
    lines.append("")
    lines.append("**Aktív kártyák (in_progress):**")
    if cards:
        for cid, title, pri in cards:
            t = " ".join((title or "").split())
            if len(t) > TITLE_CHARS:
                t = t[:TITLE_CHARS].rstrip() + "…"
            lines.append(f"- [{pri}] {cid} {t}")
    else:
        lines.append("- Nincs aktív kártya.")
    if last_inbound:
        text, ts = last_inbound
        snip = " ".join((text or "").split())
        if len(snip) > INBOUND_SNIPPET_CHARS:
            snip = snip[:INBOUND_SNIPPET_CHARS].rstrip() + "…"
        # ts is the opaque timestamp string the ledger logged (Telegram-supplied),
        # not an epoch -- render it as-is, trimmed, never reinterpret as a number.
        when = " ".join(str(ts).split())[:32] if ts else "?"
        lines.append("")
        lines.append(f"**Utolsó beszélgetés ({when}):** {snip}")
    out = "\n".join(lines).strip() + "\n"
    if len(out) > CONTENT_CHAR_LIMIT:
        out = out[:CONTENT_CHAR_LIMIT].rstrip() + "\n[truncated]\n"
    return out


def should_refresh(cache_path: Path, now: float, interval: float, force: bool) -> bool:
    if force:
        return True
    try:
        age = now - cache_path.stat().st_mtime
    except Exception:
        return True  # missing / unstat-able -> (re)generate
    return age >= interval


def _write_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".hotcache-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, str(path))
    except Exception:
        try:
            os.unlink(tmp)
        except Exception:
            pass
        raise


def refresh_agent(agent_id, install_dir, noa_db_path, now, interval, force) -> str:
    cache_path = _hot_cache_path(agent_id, install_dir)
    if not should_refresh(cache_path, now, interval, force):
        return "skip"
    cards = _load_in_progress(agent_id, noa_db_path)
    last_inbound = _last_inbound(agent_id)
    content = build_hot_cache(agent_id, cards, last_inbound, now)
    _write_atomic(cache_path, content)
    return "refresh"


def main(argv) -> int:
    force = "--force" in argv
    agents = [a for a in argv if not a.startswith("-")] or CHANNEL_AGENTS
    install_dir = _install_dir()
    noa_db = _noa_db_path(install_dir)
    now = time.time()
    results = {}
    for agent_id in agents:
        try:
            results[agent_id] = refresh_agent(
                agent_id, install_dir, noa_db, now, REFRESH_INTERVAL_SECONDS, force
            )
        except Exception as exc:  # never let one agent break the rest
            results[agent_id] = f"error:{type(exc).__name__}"
    print(json.dumps(results, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
