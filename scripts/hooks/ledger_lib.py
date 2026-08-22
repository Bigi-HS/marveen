"""Shared helpers for the deterministic conversation-continuity ledger.

The ledger (store/noa.db -> conversation_log, post-cutover) is a rolling TRANSCRIPT of
every channel turn -- inbound user messages AND outbound replies -- per
agent_id + chat_id. On a respawn (a fresh --channels session with no memory of
the live conversation) the SessionStart hook injects the last ~20 turns of
context PLUS the open question, so the fresh session continues where the
connection dropped -- with ZERO agent discretion.

Generic across all three channel agents (marveen / dia / erno-ba): agent_id is
derived from the running session's cwd so each session only ever sees its OWN
chat. Pure stdlib (sqlite3) -- no node startup, no jq.
"""
import os
import sqlite3
import time

# Canonical schema. MUST stay identical to the db.ts initDatabase() migration
# (asserted by a contract test). Created defensively so a hook that runs before
# the dashboard migration (fresh boot / respawn) still works.
SCHEMA = """
CREATE TABLE IF NOT EXISTS conversation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  message_id TEXT,
  text TEXT,
  ts TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(agent_id, chat_id, direction, message_id)
)
"""
INDEX = "CREATE INDEX IF NOT EXISTS idx_convlog_agent ON conversation_log(agent_id, created_at)"

RECENT_LIMIT = 20


def _dotenv_value(install, key):
    """Read `key` from <install>/.env, or None if absent/unreadable. Hooks run
    without the server's dotenv-preload, so a var only present in the .env file
    (like NOA_DB_PATH) has to be read from disk. Mirrors the inline .env read in
    main_agent_id()."""
    try:
        with open(os.path.join(install, ".env")) as f:
            for line in f:
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return None


def _noa_db_setting(install):
    """The configured NOA_DB_PATH: the process env wins (explicit / tests), else
    the <install>/.env file. A blank env value falls through to the file."""
    v = os.environ.get("NOA_DB_PATH")
    if v is not None and v.strip():
        return v
    return _dotenv_value(install, "NOA_DB_PATH")


def _resolve_live_db(ledger_override, noa_setting, install):
    """Resolve which DB the ledger / memory hooks read+write.

    Precedence, mirroring the server's resolveNoaDbPath (src/db-path.ts) so the
    hooks open the SAME live DB the dashboard does after the noa.db cutover:
      1. LEDGER_DB_PATH  -- explicit test seam, highest priority.
      2. NOA_DB_PATH     -- the cutover switch; resolved against `install`, must
         end in `.db` and stay strictly under the install root.
      3. default         -- <install>/store/noa.db (the live DB post-retire, card
         57480c07), used when unset/blank OR when a bad value is rejected. Fail-open
         (never raise): a hook must not break session start over a misconfigured
         path, and the fail-open target is the LIVE DB, never the frozen legacy one.
    """
    if ledger_override:
        return ledger_override
    default = os.path.join(install, "store", "noa.db")
    raw = (noa_setting or "").strip()
    if not raw:
        return default
    resolved = os.path.normpath(os.path.join(install, raw))
    if not resolved.lower().endswith(".db"):
        return default
    root = install.rstrip(os.sep) + os.sep
    if not resolved.startswith(root):
        return default
    return resolved


def db_path():
    # Hooks live in <install>/scripts/hooks/; the ledger is <install>/store/.
    # Resolve from THIS file's location so it is correct regardless of the
    # session's cwd. Test seam: LEDGER_DB_PATH. Live DB: NOA_DB_PATH (env/.env),
    # so hooks track the noa.db cutover instead of the frozen legacy default.
    install = _install_dir()
    return _resolve_live_db(
        os.environ.get("LEDGER_DB_PATH"), _noa_db_setting(install), install
    )


def _install_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def main_agent_id():
    v = os.environ.get("MAIN_AGENT_ID")
    if v:
        return v.strip()
    try:
        with open(os.path.join(_install_dir(), ".env")) as f:
            for line in f:
                if line.startswith("MAIN_AGENT_ID="):
                    return line.split("=", 1)[1].strip()
    except Exception:
        pass
    return "marveen"


def agent_id_from_cwd(cwd):
    """Which channel agent is this session? Derived from cwd so the hooks are
    generic across all three agents and never cross-contaminate:
      <install>/agents/<id>  -> <id>           (sub-agent: dia, erno-ba, ...)
      <install>               -> MAIN_AGENT_ID  (the main channels agent)
    """
    cwd = (cwd or "").rstrip("/")
    install = _install_dir().rstrip("/")
    agents_root = os.path.join(install, "agents")
    if cwd.startswith(agents_root + os.sep):
        rel = cwd[len(agents_root) + 1:]
        return rel.split(os.sep)[0] or main_agent_id()
    if cwd == install:
        return main_agent_id()
    # Fallback: last path component (best effort), else main.
    base = os.path.basename(cwd)
    return base or main_agent_id()


def connect():
    con = sqlite3.connect(db_path(), timeout=10)
    con.execute("PRAGMA busy_timeout=10000")
    con.execute(SCHEMA)
    con.execute(INDEX)
    return con


def log_inbound(agent_id, chat_id, message_id, text, ts, created_at=None):
    """Record an inbound user message. Idempotent on (agent_id, chat_id, in, message_id).

    created_at defaults to the current time -- correct for the live UserPromptSubmit
    hook, which records the message as it arrives. The reconcile (ledger-reconcile.py)
    passes the REAL transcript ts as created_at so backfilled rows keep their true
    arrival time: chronological ordering (recent() replay) and the open-question
    later-outbound check depend on it, otherwise an already-answered message would
    re-surface at reconcile-run time.
    """
    ca = int(time.time()) if created_at is None else int(created_at)
    con = connect()
    try:
        con.execute(
            "INSERT OR IGNORE INTO conversation_log"
            " (agent_id, chat_id, direction, message_id, text, ts, created_at)"
            " VALUES (?, ?, 'in', ?, ?, ?, ?)",
            (str(agent_id), str(chat_id), str(message_id), text, ts, ca),
        )
        con.commit()
    finally:
        con.close()


def log_outbound(agent_id, chat_id, text):
    """Record an outbound reply (message_id NULL -> never deduped)."""
    con = connect()
    try:
        now = int(time.time())
        con.execute(
            "INSERT INTO conversation_log"
            " (agent_id, chat_id, direction, message_id, text, ts, created_at)"
            " VALUES (?, ?, 'out', NULL, ?, ?, ?)",
            (str(agent_id), str(chat_id), text, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), now),
        )
        con.commit()
    finally:
        con.close()


def recent(agent_id, limit=RECENT_LIMIT):
    """The last `limit` turns for this agent, oldest-first. Rows: (direction, chat_id, text, ts)."""
    con = connect()
    try:
        rows = con.execute(
            "SELECT direction, chat_id, text, ts FROM conversation_log"
            " WHERE agent_id=? ORDER BY created_at DESC, id DESC LIMIT ?",
            (str(agent_id), int(limit)),
        ).fetchall()
        return list(reversed(rows))
    finally:
        con.close()


def open_question_with_age(agent_id):
    """Like open_question() but also returns the open inbound's created_at (unix
    epoch). Returns (chat_id, message_id, text, ts, created_at) or None. Used by
    the live-drain hook, which needs the age for its grace window."""
    con = connect()
    try:
        row = con.execute(
            "SELECT chat_id, message_id, text, ts, created_at, id FROM conversation_log"
            " WHERE agent_id=? AND direction='in' ORDER BY created_at DESC, id DESC LIMIT 1",
            (str(agent_id),),
        ).fetchone()
        if not row:
            return None
        chat_id, message_id, text, ts, created_at, rid = row
        later_out = con.execute(
            "SELECT 1 FROM conversation_log"
            " WHERE agent_id=? AND direction='out'"
            "   AND (created_at > ? OR (created_at = ? AND id > ?)) LIMIT 1",
            (str(agent_id), created_at, created_at, rid),
        ).fetchone()
        if later_out:
            return None  # the last inbound has already been answered
        return (chat_id, message_id, text, ts, created_at)
    finally:
        con.close()


def open_question(agent_id):
    """The most recent inbound with NO later outbound (the unanswered question),
    or None. Returns (chat_id, message_id, text, ts)."""
    oq = open_question_with_age(agent_id)
    return oq[:4] if oq else None
