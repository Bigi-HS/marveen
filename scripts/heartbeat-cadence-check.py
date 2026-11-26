#!/usr/bin/env python3
"""Heartbeat cadence regression detector (card a363c33e).

A skip-if-busy regression was invisible for 39h (monitoring blind spot).
This detector compares actual keepalive firing timestamps against the expected
cadence and raises an ALERT when 2+ consecutive expected firings are missed
AND the session is still alive (i.e. the cadence dropped while the supervisor
was running -- the dangerous class).

Fail-CLOSED: ambiguous or unreadable input -> ALERT, never silently passes.
CWD-independent: all path anchoring uses Path(__file__).resolve().parent.

Result classification:
  "ok"         -- cadence healthy or only a single miss (tolerated)
  "alert"      -- 2+ consecutive missed firings while session appears alive
  "dead"       -- session is not alive; gap explained by dead supervisor (not an alert)
  "error"      -- input is unreadable / malformed (fail-closed, same severity as alert)

Usage (pure helper):
    from scripts.heartbeat_cadence_check import classify_cadence
    result = classify_cadence(timestamps, cadence_minutes=15, now=time.time(),
                              session_alive=True)

CLI:
    python3 scripts/heartbeat-cadence-check.py \\
        --log-file /path/to/keepalive.log \\
        --cadence 15 \\
        --session-pid <pid>   # or --session-alive / --session-dead

Exit codes:
    0 = ok / dead (cadence healthy, single miss, or session dead explains gap)
    1 = alert (2+ consecutive misses with live session)
    2 = error (fail-closed: unreadable / malformed input)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import List, Optional

# CWD-independent: anchor to this file's location, never os.getcwd().
_HERE = Path(__file__).resolve().parent

# Expected cadence: memoria-heartbeat fires every */15 minutes.
DEFAULT_CADENCE_MINUTES = 15

# How many consecutive missed firings trigger an alert.
CONSECUTIVE_MISS_THRESHOLD = 2


# ---------------------------------------------------------------------------
# Pure cadence logic (importable, no I/O)
# ---------------------------------------------------------------------------


def _expected_firings(start: float, end: float, cadence_sec: float) -> int:
    """Return the number of expected firings in the half-open interval (start, end].

    Given that a firing happened at `start`, how many additional firings were
    due before `end`?  We count full cadence periods elapsed.
    """
    if end <= start or cadence_sec <= 0:
        return 0
    return int((end - start) / cadence_sec)


def classify_cadence(
    timestamps: List[float],
    cadence_minutes: float = DEFAULT_CADENCE_MINUTES,
    now: Optional[float] = None,
    session_alive: bool = True,
    warn_on_reorder=None,
) -> str:
    """Pure classifier.  Fail-CLOSED: bad input returns 'error'.

    Parameters
    ----------
    timestamps:
        Epoch-second timestamps when keepalive fired.  May be unsorted --
        the function sorts internally.  Pass warn_on_reorder to surface
        silent normalisation (advisory #1, card 013a9ab6).
    cadence_minutes:
        Expected firing interval in minutes (default 15).
    now:
        Current epoch seconds.  Required when timestamps has a single
        element (fail-closed: single-ts without now has no gap to measure).
    session_alive:
        Whether the supervisor session is considered alive.
    warn_on_reorder:
        Optional callable(original_list) -> None.  Called when the input
        was not already sorted, so callers can surface silent normalisation
        of a malformed cadence log (advisory #1, card 013a9ab6).

    Returns
    -------
    "ok"    -- healthy or <=1 miss
    "alert" -- 2+ consecutive misses with live session
    "dead"  -- session not alive; explains the gap
    "error" -- input unreadable / malformed (fail-closed)
    """
    # --- input validation (fail-closed) ---
    if not isinstance(timestamps, (list, tuple)):
        return "error"
    if not isinstance(cadence_minutes, (int, float)) or cadence_minutes <= 0:
        return "error"
    if now is not None and not isinstance(now, (int, float)):
        return "error"

    # Coerce to float list; fail-closed on bad element types.
    try:
        raw: List[float] = [float(t) for t in timestamps]
    except (TypeError, ValueError):
        return "error"

    # Need at least one timestamp to reason about gaps.
    if not raw:
        return "error"

    # Sort and optionally surface the reordering (advisory #1, card 013a9ab6).
    pts: List[float] = sorted(raw)
    if warn_on_reorder is not None and pts != raw:
        warn_on_reorder(list(timestamps))

    # Fail-closed: single timestamp without 'now' has no gap to measure.
    # Returning "ok" here would be FAIL-OPEN (advisory #2, card 013a9ab6).
    if len(pts) == 1 and now is None:
        return "error"

    cadence_sec = cadence_minutes * 60.0

    # Build the list of inter-firing gaps to examine.
    # We use consecutive pairs, then optionally add a trailing gap to `now`.
    pairs: List[tuple[float, float]] = list(zip(pts, pts[1:]))
    if now is not None and now > pts[-1]:
        pairs.append((pts[-1], float(now)))

    max_consecutive_misses = 0

    for prev, curr in pairs:
        # How many firings were expected but did not happen in this single gap?
        #
        # _expected_firings returns how many ADDITIONAL firings should have
        # occurred after `prev` before `curr`, so a gap of exactly one cadence
        # = 1 expected = 0 missed (the firing AT curr accounts for it).
        # A gap of 1.9x cadence = 1 expected = 0 missed (arrived a bit late).
        # A gap of 2.1x cadence = 2 expected, 1 missed.
        # A gap of 3.1x cadence = 3 expected, 2 missed -> alert trigger.
        #
        # NOTE: we do NOT accumulate across gaps.  The card spec says
        # "2+ consecutive expected firings are missed" -- this means a single
        # interval in which 2 or more scheduled firings are absent.  Two
        # separate gaps that each miss 1 firing do NOT combine; they are
        # separated by an actual firing event in between.
        gap_misses = max(0, _expected_firings(prev, curr, cadence_sec) - 1)
        if gap_misses > max_consecutive_misses:
            max_consecutive_misses = gap_misses

    if max_consecutive_misses >= CONSECUTIVE_MISS_THRESHOLD:
        if not session_alive:
            return "dead"
        return "alert"

    return "ok"


# ---------------------------------------------------------------------------
# Session liveness helpers (thin OS layer, mockable in tests)
# ---------------------------------------------------------------------------


def session_alive_by_pid(pid: int) -> bool:
    """Return True if a process with `pid` exists (POSIX signal 0)."""
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # Process exists but we cannot signal it -- count as alive.
        return True
    except Exception:
        # Fail-closed: unknown error -> assume alive to avoid false "dead" classification.
        return True


def session_alive_by_tmux(session_name: str) -> bool:
    """Return True if the named tmux session is currently running."""
    import subprocess

    try:
        r = subprocess.run(
            ["tmux", "has-session", "-t", session_name],
            capture_output=True,
            timeout=5,
        )
        return r.returncode == 0
    except Exception:
        # Fail-closed: cannot determine -> assume alive.
        return True


# ---------------------------------------------------------------------------
# Log file reader
# ---------------------------------------------------------------------------


def read_timestamps_from_log(log_path: str) -> List[float]:
    """Parse a keepalive log file into a sorted list of epoch-second timestamps.

    Supported formats (one per line, blank/comment lines ignored):
      - Plain epoch float/int:  ``1700000000``
      - ISO-8601 datetime:      ``2024-11-22T14:00:00``  (UTC assumed)
      - Prefixed epoch:         ``ts=1700000000`` or ``timestamp=1700000000``

    Fail-closed: any parse error on a non-blank line is propagated (the caller
    decides whether to treat the file as unusable).
    """
    import re

    path = Path(log_path).resolve()  # CWD-independent: resolve from absolute
    if not path.is_absolute():
        raise ValueError(f"log path must be absolute after resolution: {path}")

    timestamps: List[float] = []
    _epoch_prefix_re = re.compile(r"(?:ts|timestamp)\s*=\s*([0-9]+(?:\.[0-9]+)?)", re.I)
    _bare_epoch_re = re.compile(r"^\s*([0-9]{9,13}(?:\.[0-9]+)?)\s*$")

    with path.open("r", encoding="utf-8", errors="replace") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue

            # 1. Prefixed epoch (ts= / timestamp=)
            m = _epoch_prefix_re.search(line)
            if m:
                ts = float(m.group(1))
                # 13-digit = milliseconds -> convert to seconds
                if ts > 1e12:
                    ts /= 1000.0
                timestamps.append(ts)
                continue

            # 2. Bare epoch number
            m = _bare_epoch_re.match(line)
            if m:
                ts = float(m.group(1))
                if ts > 1e12:
                    ts /= 1000.0
                timestamps.append(ts)
                continue

            # 3. ISO-8601 datetime (UTC)
            try:
                from datetime import datetime, timezone

                dt = datetime.fromisoformat(line.rstrip("Z").replace("Z", ""))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                timestamps.append(dt.timestamp())
                continue
            except ValueError:
                pass

            # Unrecognised non-blank line -> fail-closed
            raise ValueError(f"Unrecognised timestamp format at line {lineno}: {line!r}")

    return timestamps


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Heartbeat cadence regression detector (card a363c33e). "
        "Checks whether keepalive timestamps show 2+ consecutive missed "
        "firings while the session was alive.",
    )
    p.add_argument(
        "--log-file",
        metavar="PATH",
        help="Path to keepalive log file (one timestamp per line).",
    )
    p.add_argument(
        "--cadence",
        type=float,
        default=DEFAULT_CADENCE_MINUTES,
        help=f"Expected firing interval in minutes (default: {DEFAULT_CADENCE_MINUTES}).",
    )

    liveness = p.add_mutually_exclusive_group()
    liveness.add_argument(
        "--session-pid",
        type=int,
        metavar="PID",
        help="Check session liveness by PID.",
    )
    liveness.add_argument(
        "--session-tmux",
        metavar="NAME",
        help="Check session liveness by tmux session name.",
    )
    liveness.add_argument(
        "--session-alive",
        action="store_true",
        default=False,
        help="Assert session is alive (no OS check, for testing).",
    )
    liveness.add_argument(
        "--session-dead",
        action="store_true",
        default=False,
        help="Assert session is dead (no OS check, for testing).",
    )
    p.add_argument(
        "--now",
        type=float,
        metavar="EPOCH",
        help="Override 'now' (epoch seconds) for deterministic testing.",
    )
    return p


def main(argv: Optional[list] = None) -> int:
    import time

    parser = _build_parser()
    args = parser.parse_args(argv)

    # Determine session liveness.
    if args.session_dead:
        alive = False
    elif args.session_alive:
        alive = True
    elif args.session_pid is not None:
        alive = session_alive_by_pid(args.session_pid)
    elif args.session_tmux is not None:
        alive = session_alive_by_tmux(args.session_tmux)
    else:
        # No liveness argument -- fail-closed: assume alive so the alert can fire.
        alive = True

    # Determine 'now'.
    now = args.now if args.now is not None else time.time()

    # Load timestamps.
    if not args.log_file:
        parser.error("--log-file is required")
    try:
        timestamps = read_timestamps_from_log(args.log_file)
    except Exception as exc:
        print(f"ERROR reading log file: {exc}", file=sys.stderr)
        print("verdict: ERROR (fail-closed)")
        return 2

    def _warn_reorder(original):
        print(
            f"WARNING: cadence log timestamps were out of order "
            f"({len(original)} entries sorted internally); "
            f"check log source for ordering issues",
            file=sys.stderr,
        )

    # Classify.
    verdict = classify_cadence(
        timestamps,
        cadence_minutes=args.cadence,
        now=now,
        session_alive=alive,
        warn_on_reorder=_warn_reorder,
    )

    status_line = {
        "ok": "verdict: OK -- cadence healthy",
        "alert": "verdict: ALERT -- 2+ consecutive missed firings with live session",
        "dead": "verdict: DEAD -- gap explained by dead/stopped session",
        "error": "verdict: ERROR (fail-closed) -- bad input",
    }.get(verdict, f"verdict: {verdict}")

    print(status_line)

    if verdict == "alert":
        return 1
    if verdict == "error":
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
