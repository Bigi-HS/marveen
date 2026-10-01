#!/usr/bin/env python3
"""Hibiki daily readiness calculator (ENG-148, card cddfd1ce).

Reads a day's Zepp snapshot (store/zepp/daily-YYYY-MM-DD.json), updates the
CTL/ATL training-load state (store/hibiki-ctl-atl.json), and emits a readiness
JSON object consumed by hibiki-wakeup-relay.py (run_readiness).

Invocation:
    python3 scripts/hibiki-readiness-calc.py --json [--date YYYY-MM-DD]

Formula contract locked with Hibiki (formula authority) 2026-10-01:
- stress.combined: HRV/RHR point model, capped at 4. level 0=GREEN, 1-2=YELLOW, 3-4=RED.
- sleep_quality.score: derived 0-5 (zepp_score // 20, capped 0..5). level >=4 GREEN, ==3 YELLOW, <=2 RED.
- deep/REM pct + avg are 0.0 (current Zepp schema has no deepMin/remMin).
- 7-day moving average = last up-to-7 AVAILABLE daily files strictly before the target
  date (gaps skipped). With 0 history, deltas are 0.0 (GREEN fallback).
- load_adjustment: base from stress (GREEN 0, YELLOW -10, RED -20); if sleep != GREEN
  AND stress != GREEN -> -20.

Guards:
- Missing today's Zepp file -> exit(1), stderr "Nincs mai Zepp adat: YYYY-MM-DD".
- CTL/ATL state is written ONLY on the success path (exit 0) -- never partial.
"""
import argparse
import json
import math
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ZEPP_DIR = REPO_ROOT / "store" / "zepp"
DEFAULT_STATE = REPO_ROOT / "store" / "hibiki-ctl-atl.json"

# Strict YYYY-MM-DD shape; the strptime check in _valid_date rejects impossible
# calendar dates (e.g. 2026-13-45) that the regex alone would admit.
_DATE_RX = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _valid_date(value: str) -> bool:
    """True only for a strict, real YYYY-MM-DD date string.

    Guards the --date -> daily-{date}.json path: a malformed value (``../``,
    a non-date, a non-zero-padded or impossible date) is rejected at the door.
    """
    if not _DATE_RX.match(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True

# Exponential-smoothing time constants (EWMA over daily training load).
_K_CTL = math.exp(-1 / 42)  # Chronic Training Load, 42-day
_K_ATL = math.exp(-1 / 7)   # Acute Training Load, 7-day


class MissingZeppData(Exception):
    """Raised when the target date has no Zepp daily snapshot."""


# ── Pure scoring primitives ────────────────────────────────────────────────

def hrv_points(delta: float) -> int:
    """HRV deviation points. Drop is bad; a large positive jump is also a signal."""
    if delta < -20:
        return 2
    if delta < -10:          # -20 <= delta < -10
        return 1
    if delta > 15:
        return 1
    return 0


def rhr_points(delta: float) -> int:
    """Resting-HR deviation points. Only an elevated RHR is a stress signal."""
    if delta > 8:
        return 2
    if delta > 5:            # +5 < delta <= +8
        return 1
    return 0


def combined_stress(hrv_pts: int, rhr_pts: int) -> int:
    return min(4, hrv_pts + rhr_pts)


def stress_level(combined: int) -> str:
    if combined == 0:
        return "GREEN"
    if combined <= 2:
        return "YELLOW"
    return "RED"


def sleep_score_5(zepp_score: int) -> int:
    """Derived 0-5 rating from the raw Zepp 0-100 sleep score."""
    return min(5, max(0, int(zepp_score) // 20))


def sleep_level(score_5: int) -> str:
    if score_5 >= 4:
        return "GREEN"
    if score_5 == 3:
        return "YELLOW"
    return "RED"


def update_ctl_atl(ctl_old: float, atl_old: float, load: float):
    """Return (ctl, atl, tsb) after folding today's training load into the EWMAs."""
    load = load or 0
    ctl = ctl_old * _K_CTL + load * (1 - _K_CTL)
    atl = atl_old * _K_ATL + load * (1 - _K_ATL)
    return ctl, atl, ctl - atl


def load_adjustment(stress_lvl: str, sleep_lvl: str) -> int:
    base = {"GREEN": 0, "YELLOW": -10, "RED": -20}[stress_lvl]
    if stress_lvl != "GREEN" and sleep_lvl != "GREEN":
        return -20
    return base


def next_session_readiness(tsb: float, stress_lvl: str) -> str:
    if tsb > 5 and stress_lvl == "GREEN":
        return "GREEN"
    if tsb < -10 or stress_lvl == "RED":
        return "RED"
    return "YELLOW"


def moving_average(values) -> float:
    return sum(values) / len(values) if values else 0.0


# ── Data access ─────────────────────────────────────────────────────────────

def _load_daily(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def collect_history(target_date: str, zepp_dir, max_n: int = 7) -> list:
    """Up to `max_n` most-recent daily snapshots strictly before `target_date`.

    Gaps are skipped (only existing files count). ISO date strings sort
    chronologically, so a lexical compare is correct here.
    """
    out = []
    for p in Path(zepp_dir).glob("daily-*.json"):
        ds = p.stem[len("daily-"):]
        if ds >= target_date:
            continue
        try:
            d = _load_daily(p)
        except (OSError, json.JSONDecodeError):
            continue
        d.setdefault("date", ds)
        out.append((ds, d))
    out.sort(key=lambda x: x[0], reverse=True)
    return [d for _, d in out[:max_n]]


def _atomic_write_json(path, obj) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


# ── Orchestration (pure: no side effects) ───────────────────────────────────

def compute_readiness(target_date: str, zepp_dir, state_path):
    """Return (result_dict, new_state_dict). Raises MissingZeppData on no snapshot.

    This function performs NO writes -- the caller persists new_state only on the
    success path, so a failure never leaves partial CTL/ATL state behind.
    """
    today_path = Path(zepp_dir) / f"daily-{target_date}.json"
    if not today_path.exists():
        raise MissingZeppData(target_date)
    today = _load_daily(today_path)

    vitals = today.get("vitals", {})
    sleep = today.get("sleep", {})
    training = today.get("training", {})
    hrv_today = vitals.get("hrv")
    rhr_today = vitals.get("restingHr")
    dur_today = int(sleep.get("durationMin", 0) or 0)
    score_today = int(sleep.get("score", 0) or 0)
    load_today = training.get("load", 0) or 0

    hist = collect_history(target_date, zepp_dir, max_n=7)
    history_days = len(hist)
    hrv_hist = [h["vitals"]["hrv"] for h in hist
                if isinstance(h.get("vitals"), dict) and h["vitals"].get("hrv") is not None]
    rhr_hist = [h["vitals"]["restingHr"] for h in hist
                if isinstance(h.get("vitals"), dict) and h["vitals"].get("restingHr") is not None]
    dur_hist = [h["sleep"]["durationMin"] for h in hist
                if isinstance(h.get("sleep"), dict) and h["sleep"].get("durationMin") is not None]

    if history_days == 0 or hrv_today is None or not hrv_hist:
        hrv_delta = 0.0
    else:
        hrv_delta = hrv_today - moving_average(hrv_hist)
    if history_days == 0 or rhr_today is None or not rhr_hist:
        rhr_delta = 0.0
    else:
        rhr_delta = rhr_today - moving_average(rhr_hist)

    combined = combined_stress(hrv_points(hrv_delta), rhr_points(rhr_delta))
    stress_lvl = stress_level(combined)

    score_5 = sleep_score_5(score_today)
    sleep_lvl = sleep_level(score_5)
    dur_avg_h = round(moving_average(dur_hist) / 60, 1) if dur_hist else 0.0

    old_state = {}
    sp = Path(state_path)
    if sp.exists():
        try:
            old_state = _load_daily(sp)
        except (OSError, json.JSONDecodeError):
            old_state = {}
    ctl, atl, tsb = update_ctl_atl(
        float(old_state.get("ctl", 0.0) or 0.0),
        float(old_state.get("atl", 0.0) or 0.0),
        load_today,
    )

    result = {
        "date": target_date,
        "ctl": round(ctl, 1),
        "atl": round(atl, 1),
        "tsb": round(tsb, 1),
        "sleep_min": dur_today,
        "stress": {
            "level": stress_lvl,
            "combined": combined,
            "hrv_today": hrv_today if hrv_today is not None else 0,
            "hrv_delta": round(hrv_delta, 2),
            "rhr_today": rhr_today if rhr_today is not None else 0,
            "rhr_delta": round(rhr_delta, 1),
        },
        "sleep_quality": {
            "level": sleep_lvl,
            "score": score_5,
            "deep_pct": 0.0,
            "rem_pct": 0.0,
            "dur_avg": dur_avg_h,
            "deep_avg": 0.0,
            "rem_avg": 0.0,
            "history_days": history_days,
        },
        "load_adjustment_pct": load_adjustment(stress_lvl, sleep_lvl),
        "recovery": {"next_session_readiness": next_session_readiness(tsb, stress_lvl)},
        "max_hr_updated": None,
    }
    new_state = {"ctl": round(ctl, 1), "atl": round(atl, 1), "tsb": round(tsb, 1), "date": target_date}
    return result, new_state


def main(argv) -> int:
    ap = argparse.ArgumentParser(description="Hibiki daily readiness calculator")
    ap.add_argument("--json", action="store_true", help="emit the readiness object as JSON on stdout")
    ap.add_argument("--date", default=None, help="target date YYYY-MM-DD (default: today)")
    ap.add_argument("--zepp-dir", default=None, help="override Zepp daily dir (default: store/zepp)")
    ap.add_argument("--state", default=None, help="override CTL/ATL state file")
    args = ap.parse_args(argv)

    if args.date is not None and not _valid_date(args.date):
        print(f"Invalid --date (expected YYYY-MM-DD): {args.date!r}", file=sys.stderr)
        return 2

    target = args.date or date.today().isoformat()
    zepp_dir = args.zepp_dir or str(DEFAULT_ZEPP_DIR)
    state_path = args.state or str(DEFAULT_STATE)

    try:
        result, new_state = compute_readiness(target, zepp_dir, state_path)
    except MissingZeppData:
        print(f"Nincs mai Zepp adat: {target}", file=sys.stderr)
        return 1

    # Success path only: persist state, then emit. A failure above never reaches here,
    # so partial CTL/ATL is never written.
    _atomic_write_json(state_path, new_state)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
