#!/usr/bin/env python3
"""Run-signal recorder for the change-impact-analysis skill (Fleet Phase 1, Dave).

Every invocation of the change-impact-analysis pre-flight appends ONE validated
JSONL line to store/change-impact-log.jsonl. This is the skill's measurable
run-signal (trigger-first rule, Chad+Dave): without it a skill that is never
invoked is indistinguishable from one that runs and finds nothing -- the same
false-green as a silent guard.

Contract enforced here (an honest telemetry file never holds a malformed row):
  - classification in {ran, skipped-trivial}; decision in {proceed, mitigate, hold}
  - findings_count >= 0
  - a `skipped-trivial` row carries NO findings and decision=proceed (a skip
    means no analysis ran, so it cannot report findings or ask to hold)
  - the skip is logged too, so a window with ZERO rows means the TRIGGER never
    fired (a detectable dead-skill), not "nothing happened"

Usage:
  python3 scripts/change-impact-log.py \
    --agent dave --change-ref pr#500 --classification ran \
    --findings 2 --top-risk "live-vs-source delta" --decision mitigate
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

_CLASSIFICATIONS = ("ran", "skipped-trivial")
_DECISIONS = ("proceed", "mitigate", "hold")
_TZ = ZoneInfo("Europe/Budapest")

_DEFAULT_LOG = Path(__file__).resolve().parent.parent / "store" / "change-impact-log.jsonl"


def build_record(agent, change_ref, classification, findings, top_risk, decision):
    """Validate the inputs and return the record dict, or raise ValueError.

    Kept pure (no I/O, no clock beyond stamping ts) so the contract is unit
    testable without touching the filesystem.
    """
    if not agent or not str(agent).strip():
        raise ValueError("agent is required")
    if not change_ref or not str(change_ref).strip():
        raise ValueError("change_ref is required")
    if classification not in _CLASSIFICATIONS:
        raise ValueError(f"classification must be one of {_CLASSIFICATIONS}, got {classification!r}")
    if decision not in _DECISIONS:
        raise ValueError(f"decision must be one of {_DECISIONS}, got {decision!r}")
    findings = int(findings)
    if findings < 0:
        raise ValueError("findings_count must be >= 0")
    if classification == "skipped-trivial":
        # A skip means no analysis ran: it cannot carry findings, and its only
        # honest decision is proceed. Anything else is a mislabelled row.
        if findings != 0:
            raise ValueError("skipped-trivial cannot carry findings")
        if decision != "proceed":
            raise ValueError("skipped-trivial decision must be proceed")

    return {
        "ts": datetime.now(_TZ).isoformat(timespec="seconds"),
        "agent": str(agent).strip(),
        "change_ref": str(change_ref).strip(),
        "classification": classification,
        "findings_count": findings,
        "top_risk": str(top_risk or "").strip(),
        "decision": decision,
    }


def append_record(record, log_path=_DEFAULT_LOG):
    """Append one JSON line to the log, creating parent dir if needed."""
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def main(argv=None):
    p = argparse.ArgumentParser(description="Append a change-impact run-signal line.")
    p.add_argument("--agent", required=True)
    p.add_argument("--change-ref", required=True)
    p.add_argument("--classification", required=True)
    p.add_argument("--findings", type=int, default=0)
    p.add_argument("--top-risk", default="")
    p.add_argument("--decision", required=True)
    p.add_argument("--log-path", default=str(_DEFAULT_LOG))
    args = p.parse_args(argv)

    try:
        rec = build_record(
            agent=args.agent, change_ref=args.change_ref,
            classification=args.classification, findings=args.findings,
            top_risk=args.top_risk, decision=args.decision,
        )
    except ValueError as e:
        print(f"change-impact-log: {e}", file=sys.stderr)
        return 2

    append_record(rec, args.log_path)
    print(json.dumps(rec, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
