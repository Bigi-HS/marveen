#!/usr/bin/env python3
"""Shared live-DB path resolver for standalone Python scripts (card 57480c07).

The noa.db cutover points NOA_DB_PATH at the migrated live database; the frozen
store/claudeclaw.db is legacy. Standalone scripts that read/write the operational
tables (memories / kanban / agent_messages) must resolve the same way the server
and the hook layer do, and MUST fail open to the LIVE store/noa.db -- never the
frozen legacy db -- when NOA_DB_PATH is unset or invalid.

This mirrors the resolver already inlined in direct-send.py / fallback_llm_client.py
/ medic/bot.py / memory/dream_engine.py; those copies are slated to migrate onto
this util (marveen NIT on PR#376). New consumers import this instead of copying.
"""
import os


def resolve_default_db(env=None, project_root=None):
    """Return the DB path a standalone script should default to.

    Honors NOA_DB_PATH only if it names a `.db` path that stays under
    `project_root`; anything else (unset / blank / non-.db / root escape) fails
    open to `<project_root>/store/noa.db`.

    Args:
        env: mapping to read NOA_DB_PATH from (defaults to os.environ).
        project_root: repo root the DB lives under. Defaults to the parent of
            this file's directory (scripts/.. == repo root), so callers that
            live directly under scripts/ can omit it.
    """
    env = os.environ if env is None else env
    if project_root is None:
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    default = os.path.join(project_root, "store", "noa.db")
    raw = (env.get("NOA_DB_PATH") or "").strip()
    if not raw:
        return default
    resolved = os.path.abspath(os.path.join(project_root, raw))
    root_with_sep = project_root.rstrip(os.sep) + os.sep
    if resolved.endswith(".db") and resolved.startswith(root_with_sep):
        return resolved
    return default
