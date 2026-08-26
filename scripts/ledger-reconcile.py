#!/usr/bin/env python3
"""Durable, idempotent reconcile for the ledger inbound capture-gap (card 75fe1e5d).

The live UserPromptSubmit hook (scripts/hooks/ledger-capture.py) records inbound
Telegram messages into conversation_log. But a message injected MID-TURN into a
BUSY channels session does NOT fire UserPromptSubmit, so ~43% of inbound is
silently lost during busy windows (outbound via PostToolUse stays reliable). This
script heals the gap by reading the authoritative session transcripts (*.jsonl)
and INSERT-OR-IGNOREing any inbound that is missing from the ledger.

It is safe to run on a schedule: idempotent on the natural key exactly like the
hook, inbound-only (never touches outbound rows), and it takes created_at from the
REAL transcript ts (not the reconcile-run time) so chronological ordering and the
open-question later-outbound check stay correct.

Transcript parsing lives HERE (a distinct concern from the DB layer); the CH regex,
attr(), _walk_strings() and ts_to_epoch() are adapted from the proven one-off
scripts/_ledger-inbound-backfill.py. DB access reuses scripts/hooks/ledger_lib.py
(db_path + connect + log_inbound), so the LEDGER_DB_PATH / NOA_DB_PATH resolution
is identical to the live hooks.

Usage:
    python3 scripts/ledger-reconcile.py [--dry-run] [--window-hours N]

Default action (no flags) = reconcile + WRITE, meant to run from cron.
"""
import argparse
import calendar
import glob
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "hooks"))
import ledger_lib  # noqa: E402

# --- reconcile targets ------------------------------------------------------
# One row per channel agent whose transcript we heal. Adding another channel
# agent (dia / erno-ba / ...) is a one-line addition here.
# Extended to all channel agents (card bff004ed, ENG-038): gyore, percy, bond,
# hibiki, claudia in addition to marveen.
TARGETS = [
    {"agent_id": "marveen", "sess_dir": "/home/domin/.claude/projects/-home-domin-marveen"},
    {"agent_id": "gyore",   "sess_dir": "/home/domin/.claude/projects/-home-domin-marveen-agents-gyore"},
    {"agent_id": "percy",   "sess_dir": "/home/domin/.claude/projects/-home-domin-marveen-agents-percy"},
    {"agent_id": "bond",    "sess_dir": "/home/domin/.claude/projects/-home-domin-marveen-agents-bond"},
    {"agent_id": "hibiki",  "sess_dir": "/home/domin/.claude/projects/-home-domin-marveen-agents-hibiki"},
    {"agent_id": "claudia", "sess_dir": "/home/domin/.claude/projects/-home-domin-marveen-agents-claudia"},
]

# <channel source="plugin:telegram:telegram" chat_id="X" message_id="Y" ... ts="Z">
#   TEXT
# </channel>
CH = re.compile(
    r'<channel\s+source="plugin:telegram:telegram"([^>]*)>(.*?)</channel>',
    re.DOTALL,
)


def attr(attrs, name):
    m = re.search(name + r'="([^"]*)"', attrs)
    return m.group(1) if m else None


def ts_to_epoch(ts):
    """Parse an ISO-8601 UTC ts ('2026-07-19T12:00:39.000Z') to a unix epoch.

    Uses calendar.timegm (reads the struct_time as UTC, matching the 'Z' suffix),
    NOT time.mktime -- mktime interprets the struct_time as LOCAL time and so
    introduces a 1h error across a DST boundary. Returns None on unparseable ts.
    """
    if not ts:
        return None
    s = re.sub(r"\.\d+", "", ts.strip())  # drop fractional seconds
    s = s.replace("Z", "")
    try:
        return calendar.timegm(time.strptime(s, "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        return None


def _walk_strings(obj):
    """Yield every string value anywhere in a decoded JSON object. The channel tag
    can sit in message.content, a content-block text, a tool result, etc., so we
    don't depend on transcript shape."""
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _walk_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_strings(v)


def extract_tags(sess_dir, window_hours):
    """(chat_id, message_id) -> (chat_id, ts, text) for every telegram channel tag
    in the *.jsonl files under sess_dir modified within window_hours.

    Keyed by (chat_id, message_id): the natural dedup key includes chat_id, so two
    different chats can legitimately share a message_id. Tags with no message_id
    (can't dedup) or no chat_id (no key) are skipped. First occurrence wins."""
    found = {}
    cutoff = time.time() - window_hours * 3600
    for path in glob.glob(os.path.join(sess_dir, "*.jsonl")):
        try:
            if os.path.getmtime(path) < cutoff:
                continue
            with open(path) as fh:
                for line in fh:
                    if "plugin:telegram:telegram" not in line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    for s in _walk_strings(obj):
                        if "plugin:telegram:telegram" not in s:
                            continue
                        for m in CH.finditer(s):
                            attrs, body = m.group(1), m.group(2)
                            cid = attr(attrs, "chat_id")
                            mid = attr(attrs, "message_id")
                            ts = attr(attrs, "ts")
                            if not cid or not mid:
                                continue  # can't key / can't dedup -> skip
                            found.setdefault((cid, mid), (cid, ts, body.strip()))
        except Exception:
            pass  # a single bad transcript never aborts the reconcile
    return found


def reconcile(agent_id, sess_dir, window_hours=24, write=True, con=None):
    """Heal the inbound gap for one agent. Returns {found, already, inserted}.

    Inbound-only, idempotent. Existing rows are looked up per (agent_id, chat_id,
    direction='in') and only the missing message_ids are inserted, each with
    created_at from the real transcript ts (falling back to now only if the ts is
    unparseable). Outbound rows are never read or written.
    """
    found = extract_tags(sess_dir, window_hours)
    owns_con = con is None
    if owns_con:
        con = ledger_lib.connect()
    try:
        # existing inbound message_ids, per chat_id (the natural key includes chat)
        have = {}
        for cid, mid in (
            (r[0], r[1])
            for r in con.execute(
                "SELECT chat_id, message_id FROM conversation_log"
                " WHERE agent_id=? AND direction='in'",
                (str(agent_id),),
            )
        ):
            have.setdefault(cid, set()).add(mid)

        missing = [
            (cid, mid, ts, body)
            for (cid, mid), (cid, ts, body) in found.items()
            if mid not in have.get(cid, ())
        ]
        already = len(found) - len(missing)

        inserted = 0
        if write:
            now = int(time.time())
            for cid, mid, ts, body in missing:
                created = ts_to_epoch(ts) or now
                ledger_lib.log_inbound(agent_id, cid, mid, body, ts, created_at=created)
                inserted += 1
        return {"found": len(found), "already": already, "inserted": inserted}
    finally:
        if owns_con:
            con.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description="Durable ledger inbound reconcile (card 75fe1e5d).")
    ap.add_argument("--dry-run", action="store_true", help="report only, do not insert")
    ap.add_argument("--window-hours", type=int, default=24,
                    help="only scan transcripts modified within this window (default 24)")
    args = ap.parse_args(argv)

    write = not args.dry_run
    for t in TARGETS:
        summary = reconcile(
            t["agent_id"], t["sess_dir"], window_hours=args.window_hours, write=write,
        )
        suffix = " (dry-run)" if args.dry_run else ""
        print(
            f"ledger-reconcile {t['agent_id']}: "
            f"found={summary['found']} already={summary['already']} "
            f"inserted={summary['inserted']}{suffix}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
