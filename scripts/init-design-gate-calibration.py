#!/usr/bin/env python3
"""Initialize store/design-gate-calibration.json if not present.

Run once at deploy time (or by the first design-gate review).
Idempotent: safe to run multiple times; never overwrites existing data.

Card 99d18f95 §8.3 -- design-gate calibration counter.
"""
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STORE = HERE.parent / "store"
CAL_PATH = STORE / "design-gate-calibration.json"

INITIAL = {
    "ui_prs_reviewed": 0,
    "block_capable": False,
    "calibration_window": 10,
    "history": [],
    "_note": (
        "FLAG-only until ui_prs_reviewed >= calibration_window (10). "
        "After that block_capable=true and design verdicts are enforced at BLOCK level. "
        "Card 99d18f95 §8.3."
    ),
}


def main():
    if CAL_PATH.exists():
        try:
            existing = json.loads(CAL_PATH.read_text())
            reviewed = existing.get("ui_prs_reviewed", 0)
            block_capable = existing.get("block_capable", False)
            print(
                f"[design-gate-calibration] Already initialized: "
                f"ui_prs_reviewed={reviewed}, block_capable={block_capable}. "
                "No changes made."
            )
            return 0
        except json.JSONDecodeError:
            print(
                f"[design-gate-calibration] WARN: existing file is invalid JSON. "
                "Reinitializing.",
                file=sys.stderr,
            )

    STORE.mkdir(exist_ok=True)
    CAL_PATH.write_text(json.dumps(INITIAL, indent=2) + "\n")
    print(
        f"[design-gate-calibration] Initialized at {CAL_PATH}. "
        f"FLAG-only for first {INITIAL['calibration_window']} UI PRs."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
