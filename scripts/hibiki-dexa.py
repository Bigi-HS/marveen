#!/usr/bin/env python3
"""Hibiki DEXA body-composition analysis (E-AC1 I/O contract).

Self-contained, pure-stdlib implementation of the DEXA half of the Hibiki
personal-trainer capability (spec `store/specs/hibiki-personal-trainer.md`,
section E; evidence base `docs/hibiki-knowledge.md`, section 5).

This module owns the **I/O contract only** -- it does NOT parse a PDF/link.
A separate extraction step (capability subtask 0f1de6eb) is expected to hand it
an already-parsed structured `dexa_result`; this module:

  1. defines + validates the parsed DEXA input schema,
  2. stores each scan into Hibiki's agent-private progress store,
  3. compares the scan against prior scans and emits a TREND report.

Trend rules (from `docs/hibiki-knowledge.md` section 5 / spec E-AC1):
  - need >= 2 scans for a trend; 3+ for a reliable trend,
  - 6-12 week interval between scans is the recommended cadence
    (shorter = noise; longer = stale),
  - flag: lean mass declining despite training
      -> raise protein target or reduce deficit,
  - flag: body fat % flat (unchanged) for 6+ weeks
      -> adjust deficit or activity.

Privacy (spec F-AC3 / knowledge section 9): the progress store lives under
`agents/hibiki/store/`; this module NEVER logs body-composition metrics to
stdout/stderr. The trend report is returned to the caller as a dict; printing
it is the caller's decision, not this module's.

Pure stdlib: json, pathlib, dataclasses, datetime, enum, typing. No 3rd-party.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Paths / constants
# ---------------------------------------------------------------------------

# Agent-private progress store (spec F-AC3). Resolved relative to the repo root
# (scripts/ is one level below it) so the module works from any cwd.
_REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROGRESS_STORE = _REPO_ROOT / "agents" / "hibiki" / "store" / "hibiki-progress.json"

# Recommended scan-interval window in days (6-12 weeks).
MIN_INTERVAL_DAYS = 42   # 6 weeks
MAX_INTERVAL_DAYS = 84   # 12 weeks

# A trend needs >= 2 scans; >= 3 is "reliable".
MIN_SCANS_FOR_TREND = 2
MIN_SCANS_FOR_RELIABLE = 3

# "body fat flat for 6+ weeks" trigger: how small a delta counts as unchanged,
# and how long the stall must persist.
BODY_FAT_FLAT_EPSILON_PCT = 0.5   # within +/-0.5 pct points = "unchanged"
BODY_FAT_FLAT_MIN_DAYS = 42       # 6 weeks


# ---------------------------------------------------------------------------
# Input schema
# ---------------------------------------------------------------------------


class DexaError(ValueError):
    """Raised when a DEXA input record violates the contract."""


@dataclass
class DexaResult:
    """A single parsed DEXA scan (the E-AC1 input contract).

    Required: `date`, `body_fat_pct`, `lean_mass_kg`.
    Optional: `bone_density_tscore`, `visceral_fat` -- partial scans are allowed
    (spec edge case: "store what is present; log missing fields as null; do not
    block plan generation").
    """

    date: str                                  # ISO date "YYYY-MM-DD"
    body_fat_pct: float                        # e.g. 22.4
    lean_mass_kg: float                        # e.g. 61.3
    bone_density_tscore: Optional[float] = None
    visceral_fat: Optional[float] = None

    # --- validation -------------------------------------------------------

    def __post_init__(self) -> None:
        self.date = _validate_iso_date(self.date, "date")
        self.body_fat_pct = _validate_pct(self.body_fat_pct, "body_fat_pct")
        self.lean_mass_kg = _validate_positive(self.lean_mass_kg, "lean_mass_kg")
        if self.bone_density_tscore is not None:
            self.bone_density_tscore = _validate_number(
                self.bone_density_tscore, "bone_density_tscore"
            )
        if self.visceral_fat is not None:
            self.visceral_fat = _validate_positive_or_zero(
                self.visceral_fat, "visceral_fat"
            )

    # --- serialization ----------------------------------------------------

    def to_record(self) -> dict[str, Any]:
        """The stored shape (missing optional fields persist as null)."""
        return {
            "date": self.date,
            "body_fat_pct": self.body_fat_pct,
            "lean_mass_kg": self.lean_mass_kg,
            "bone_density": self.bone_density_tscore,
            "visceral_fat": self.visceral_fat,
        }

    @classmethod
    def from_record(cls, rec: dict[str, Any]) -> "DexaResult":
        """Parse a stored / inbound record into a validated DexaResult.

        Accepts both the stored key `bone_density` and the input alias
        `bone_density_tscore` for resilience.
        """
        if not isinstance(rec, dict):
            raise DexaError(f"DEXA record must be an object, got {type(rec).__name__}")
        if "date" not in rec:
            raise DexaError("DEXA record missing required field 'date'")
        if "body_fat_pct" not in rec:
            raise DexaError("DEXA record missing required field 'body_fat_pct'")
        if "lean_mass_kg" not in rec:
            raise DexaError("DEXA record missing required field 'lean_mass_kg'")
        bone = rec.get("bone_density_tscore", rec.get("bone_density"))
        return cls(
            date=rec["date"],
            body_fat_pct=rec["body_fat_pct"],
            lean_mass_kg=rec["lean_mass_kg"],
            bone_density_tscore=bone,
            visceral_fat=rec.get("visceral_fat"),
        )


# ---------------------------------------------------------------------------
# Validators (small, local; no external deps)
# ---------------------------------------------------------------------------


def _validate_iso_date(value: Any, field_name: str) -> str:
    if not isinstance(value, str):
        raise DexaError(f"'{field_name}' must be an ISO date string")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise DexaError(f"'{field_name}' is not a valid ISO date: {value!r}") from exc
    return value


def _validate_number(value: Any, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DexaError(f"'{field_name}' must be a number")
    return float(value)


def _validate_positive(value: Any, field_name: str) -> float:
    num = _validate_number(value, field_name)
    if num <= 0:
        raise DexaError(f"'{field_name}' must be > 0, got {num}")
    return num


def _validate_positive_or_zero(value: Any, field_name: str) -> float:
    num = _validate_number(value, field_name)
    if num < 0:
        raise DexaError(f"'{field_name}' must be >= 0, got {num}")
    return num


def _validate_pct(value: Any, field_name: str) -> float:
    num = _validate_number(value, field_name)
    if not 0 < num < 100:
        raise DexaError(f"'{field_name}' must be in (0, 100), got {num}")
    return num


def _days_between(earlier_iso: str, later_iso: str) -> int:
    return (date.fromisoformat(later_iso) - date.fromisoformat(earlier_iso)).days


# ---------------------------------------------------------------------------
# Store: load / append DEXA scans into the progress store
# ---------------------------------------------------------------------------


def load_dexa_results(store_path: Path | str = DEFAULT_PROGRESS_STORE) -> list[DexaResult]:
    """Load the `dexa_results` array from the progress store, sorted by date.

    A missing store file (or missing array) yields an empty list -- the first
    scan is a legitimate state, not an error.
    """
    path = Path(store_path)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise DexaError(f"progress store is not valid JSON: {path}") from exc
    raw = data.get("dexa_results", []) if isinstance(data, dict) else []
    results = [DexaResult.from_record(r) for r in raw]
    results.sort(key=lambda r: r.date)
    return results


def add_dexa_result(
    result: DexaResult,
    store_path: Path | str = DEFAULT_PROGRESS_STORE,
) -> list[DexaResult]:
    """Append `result` to the progress store's `dexa_results` array and persist.

    Preserves every other key in the progress store. Creates the store (and
    parent dirs) if absent. Returns the full date-sorted scan list afterwards.
    """
    path = Path(store_path)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise DexaError(f"progress store is not valid JSON: {path}") from exc
        if not isinstance(data, dict):
            raise DexaError("progress store root must be a JSON object")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {}

    results = data.get("dexa_results")
    if not isinstance(results, list):
        results = []
    results.append(result.to_record())
    # Keep the stored array date-sorted so order never depends on insert order.
    results.sort(key=lambda r: r["date"])
    data["dexa_results"] = results

    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return [DexaResult.from_record(r) for r in results]


# ---------------------------------------------------------------------------
# Trend analysis
# ---------------------------------------------------------------------------


class TrendDirection(str, Enum):
    UP = "up"
    DOWN = "down"
    FLAT = "flat"


class TrendStatus(str, Enum):
    INSUFFICIENT = "insufficient"   # < 2 scans
    PRELIMINARY = "preliminary"     # exactly 2 scans
    RELIABLE = "reliable"           # 3+ scans


@dataclass
class TrendFlag:
    """A single actionable correction trigger."""

    code: str            # machine code, e.g. "lean_mass_decline"
    message: str         # human-readable explanation
    recommendation: str  # the plan-side correction


@dataclass
class TrendReport:
    """Result of comparing the latest scan against prior scans."""

    status: TrendStatus
    scan_count: int
    latest_date: Optional[str] = None
    previous_date: Optional[str] = None
    interval_days: Optional[int] = None
    interval_in_window: Optional[bool] = None   # within the 6-12 week cadence?
    body_fat_direction: Optional[TrendDirection] = None
    body_fat_delta_pct: Optional[float] = None
    lean_mass_direction: Optional[TrendDirection] = None
    lean_mass_delta_kg: Optional[float] = None
    flags: list[TrendFlag] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "scan_count": self.scan_count,
            "latest_date": self.latest_date,
            "previous_date": self.previous_date,
            "interval_days": self.interval_days,
            "interval_in_window": self.interval_in_window,
            "body_fat_direction": (
                self.body_fat_direction.value if self.body_fat_direction else None
            ),
            "body_fat_delta_pct": self.body_fat_delta_pct,
            "lean_mass_direction": (
                self.lean_mass_direction.value if self.lean_mass_direction else None
            ),
            "lean_mass_delta_kg": self.lean_mass_delta_kg,
            "flags": [
                {"code": f.code, "message": f.message, "recommendation": f.recommendation}
                for f in self.flags
            ],
            "notes": list(self.notes),
        }


def _direction(delta: float, epsilon: float) -> TrendDirection:
    if delta > epsilon:
        return TrendDirection.UP
    if delta < -epsilon:
        return TrendDirection.DOWN
    return TrendDirection.FLAT


def analyze_trend(
    results: list[DexaResult],
    *,
    in_training: bool = True,
) -> TrendReport:
    """Compare the latest scan against the prior scan and emit a TrendReport.

    `in_training` reflects whether Dominik is actively training; the lean-mass
    decline flag is a "despite training" trigger (spec E-AC1) and only fires
    when training is active.

    For the body-fat-stall flag we look back across ALL scans within the trailing
    6-week window (not just the immediately previous scan), because the stall
    trigger is about a multi-week plateau, not a single interval.
    """
    scans = sorted(results, key=lambda r: r.date)
    count = len(scans)

    if count < MIN_SCANS_FOR_TREND:
        return TrendReport(
            status=TrendStatus.INSUFFICIENT,
            scan_count=count,
            latest_date=scans[-1].date if scans else None,
            notes=[
                f"Need >= {MIN_SCANS_FOR_TREND} scans for a trend "
                f"({MIN_SCANS_FOR_RELIABLE}+ for a reliable one); have {count}."
            ],
        )

    latest = scans[-1]
    previous = scans[-2]
    interval = _days_between(previous.date, latest.date)
    in_window = MIN_INTERVAL_DAYS <= interval <= MAX_INTERVAL_DAYS

    bf_delta = round(latest.body_fat_pct - previous.body_fat_pct, 2)
    lm_delta = round(latest.lean_mass_kg - previous.lean_mass_kg, 2)
    bf_dir = _direction(bf_delta, BODY_FAT_FLAT_EPSILON_PCT)
    lm_dir = _direction(lm_delta, 0.0)

    status = (
        TrendStatus.RELIABLE
        if count >= MIN_SCANS_FOR_RELIABLE
        else TrendStatus.PRELIMINARY
    )

    report = TrendReport(
        status=status,
        scan_count=count,
        latest_date=latest.date,
        previous_date=previous.date,
        interval_days=interval,
        interval_in_window=in_window,
        body_fat_direction=bf_dir,
        body_fat_delta_pct=bf_delta,
        lean_mass_direction=lm_dir,
        lean_mass_delta_kg=lm_delta,
    )

    # --- cadence note (not a correction flag; just informs reliability) ---
    if interval < MIN_INTERVAL_DAYS:
        report.notes.append(
            f"Scan interval {interval}d is below the {MIN_INTERVAL_DAYS}d "
            "(6-week) floor; body comp moves slowly, treat the delta as noise."
        )
    elif interval > MAX_INTERVAL_DAYS:
        report.notes.append(
            f"Scan interval {interval}d exceeds the {MAX_INTERVAL_DAYS}d "
            "(12-week) ceiling; consider a fresh scan for an actionable trend."
        )

    # --- Flag 1: lean mass declining despite training ---------------------
    if in_training and lm_dir is TrendDirection.DOWN:
        report.flags.append(
            TrendFlag(
                code="lean_mass_decline",
                message=(
                    f"Lean mass down {abs(lm_delta)} kg "
                    f"({previous.date} -> {latest.date}) despite training."
                ),
                recommendation=(
                    "Raise the protein target toward 1.8-2.2 g/kg, or reduce the "
                    "caloric deficit (protein is the primary lean-mass modulator "
                    "in a deficit -- ISSN)."
                ),
            )
        )

    # --- Flag 2: body fat % unchanged for 6+ weeks ------------------------
    stall_span = _body_fat_stall_span(scans)
    if stall_span is not None and stall_span >= BODY_FAT_FLAT_MIN_DAYS:
        report.flags.append(
            TrendFlag(
                code="body_fat_stall",
                message=(
                    f"Body fat % unchanged (within +/-{BODY_FAT_FLAT_EPSILON_PCT} "
                    f"pct) for {stall_span} days."
                ),
                recommendation=(
                    "Adjust the caloric deficit (200-500 kcal/day below TDEE) or "
                    "increase activity; the formula TDEE is only an estimate -- "
                    "correct from the trend."
                ),
            )
        )

    return report


def _body_fat_stall_span(scans: list[DexaResult]) -> Optional[int]:
    """Days over which body fat % has stayed flat through the latest scan.

    Walks backward from the latest scan while each consecutive step stays within
    BODY_FAT_FLAT_EPSILON_PCT, and returns the total span in days from the
    earliest still-flat scan to the latest. Returns None if there is no
    consecutive flat step ending at the latest scan.
    """
    if len(scans) < 2:
        return None
    latest = scans[-1]
    earliest_flat_date: Optional[str] = None
    for older in reversed(scans[:-1]):
        if abs(latest.body_fat_pct - older.body_fat_pct) <= BODY_FAT_FLAT_EPSILON_PCT:
            earliest_flat_date = older.date
        else:
            break
    if earliest_flat_date is None:
        return None
    return _days_between(earliest_flat_date, latest.date)


# ---------------------------------------------------------------------------
# High-level entry point
# ---------------------------------------------------------------------------


def ingest_and_report(
    dexa_input: dict[str, Any],
    store_path: Path | str = DEFAULT_PROGRESS_STORE,
    *,
    in_training: bool = True,
) -> TrendReport:
    """Validate a parsed DEXA input, persist it, and return the trend report.

    This is the single call the capability layer (subtask 0f1de6eb) makes after
    it has extracted a structured `dexa_result` from a PDF/link. The returned
    TrendReport is data only -- never printed here, to honor the no-health-data-
    to-stdout rule (spec F-AC3).
    """
    result = DexaResult.from_record(dexa_input)
    all_scans = add_dexa_result(result, store_path)
    return analyze_trend(all_scans, in_training=in_training)


if __name__ == "__main__":  # pragma: no cover
    # Intentionally minimal: this module is a library invoked by Hibiki's
    # capability layer, and printing body-composition metrics to stdout is
    # forbidden (spec F-AC3). Emit only a non-sensitive usage hint.
    import sys

    sys.stderr.write(
        "hibiki-dexa is a library (import it). It deliberately prints no "
        "body-composition data; the capability layer consumes its TrendReport.\n"
    )
    sys.exit(0)
