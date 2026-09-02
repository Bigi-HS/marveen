#!/usr/bin/env python3
"""
Hibiki wake-up readiness relay -- NON-LLM, token-free.

Fut minden 30 percben (szinkronban a Zepp poll-lal). Amikor a Zepp daily
fájlban megjelenik a sleep.endAt (Dominik felkelt), azonnal kiszámolja a
readiness-t és elküldi Telegramon + relayeli NoA-nak. Naponta egyszer küld.

Használat:
  python3 scripts/hibiki-wakeup-relay.py
  python3 scripts/hibiki-wakeup-relay.py --dry-run
  python3 scripts/hibiki-wakeup-relay.py --date 2026-08-24
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timezone

log = logging.getLogger("hibiki-wakeup")

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..")
STORE_ROOT = os.path.join(REPO_ROOT, "agents", "hibiki", "store")
ZEPP_DIR = os.path.join(REPO_ROOT, "store", "zepp")
SCRIPTS_DIR = os.path.join(REPO_ROOT, "scripts")

# Calorie goal formula: BMR + activeKcal - deficit (Boss-jóváhagyás 2026-08-25)
CALORIE_BMR = 2200
CALORIE_DEFICIT = 400
ACTIVE_KCAL_SANITY_MIN = 50    # below this + high steps = suspect
STEPS_SANITY_THRESHOLD = 3000  # min steps for floor trigger
KCAL_PER_STEP_FLOOR = 0.022    # calibrated from sedentary days
KCAL_FLOOR_MAX = 500


def zepp_path(d: date) -> str:
    return os.path.join(ZEPP_DIR, f"daily-{d}.json")


def flag_path(d: date) -> str:
    return os.path.join(STORE_ROOT, f".wakeup-relay-{d}.flag")


def plan_path_for(d: date) -> str:
    iso = d.isocalendar()
    week_key = f"{iso[0]}-W{iso[1]:02d}"
    return os.path.join(STORE_ROOT, "plans", f"hibiki-plan-{week_key}.json")


def load_token() -> str | None:
    env_path = os.path.join(
        REPO_ROOT, "agents", "hibiki", ".claude", "channels", "telegram", ".env"
    )
    try:
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("TELEGRAM_BOT_TOKEN="):
                    return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return None


def load_push_config() -> dict:
    path = os.path.join(STORE_ROOT, "push-config.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except OSError:
        return {}


def send_telegram(token: str, chat_id: str, text: str) -> bool:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps({"chat_id": chat_id, "text": text}).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status == 200
    except urllib.error.URLError as e:
        log.error("Telegram send failed: %s", e)
        return False


def send_interagent(content: str) -> bool:
    """NoA API-n: inter-agent üzenet a readiness relay-hez."""
    token_path = os.path.join(REPO_ROOT, "store", ".dashboard-token")
    try:
        with open(token_path, encoding="utf-8") as f:
            token = f.read().strip()
    except OSError:
        log.warning("dashboard-token nem olvasható, inter-agent skip")
        return False
    payload = json.dumps({
        "from": "hibiki",
        "to": "marveen",
        "content": content,
    }).encode()
    req = urllib.request.Request(
        "http://localhost:3420/api/messages",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status == 200
    except urllib.error.URLError as e:
        log.warning("inter-agent send failed: %s", e)
        return False


def run_readiness(target_date: date) -> dict | None:
    script = os.path.join(SCRIPTS_DIR, "hibiki-readiness-calc.py")
    try:
        result = subprocess.run(
            [sys.executable, script, "--json", "--date", str(target_date)],
            capture_output=True, text=True, cwd=REPO_ROOT, timeout=30,
        )
        if result.returncode != 0:
            log.error("readiness-calc failed: %s", result.stderr[:200])
            return None
        return json.loads(result.stdout)
    except Exception as e:
        log.error("readiness-calc exception: %s", e)
        return None


def run_muscle_recovery(target_date: date, session_label: str) -> str:
    script = os.path.join(SCRIPTS_DIR, "hibiki-muscle-recovery.py")
    try:
        result = subprocess.run(
            [sys.executable, script, "--date", str(target_date), "--session", session_label],
            capture_output=True, text=True, cwd=REPO_ROOT, timeout=15,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except Exception:
        return ""


def today_session(d: date) -> dict | None:
    """A mai nap session objektuma a tervből (label, exercises, stb.)."""
    plan_file = plan_path_for(d)
    if not os.path.exists(plan_file):
        return None
    try:
        with open(plan_file, encoding="utf-8") as f:
            plan = json.load(f)
        weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        day_name = weekdays[d.weekday()]
        for s in plan.get("weekly_sessions", []):
            if s.get("day") == day_name:
                return s
    except Exception:
        pass
    return None


def compute_calorie_goal(zepp: dict) -> tuple[int | None, bool, bool]:
    """Returns (calorie_goal, used_floor, upstream_suspect).

    calorie_goal is None when the upstream activeKcalSuspect flag is set --
    AC-1/AC-4 (WELL-027): a suspect snapshot must NOT produce a Boss-facing number.
    The caller suppresses the calorie line and shows a warning instead.

    When activeKcalSuspect is absent or False, falls back to the local sanity
    guard (low activeKcal vs high steps) and emits a floor estimate when needed.

    08-25 incident: activeKcal=5 with 15790 steps -> formula gave 1805 instead of
    2811 because no floor was applied for non-null low values. This guard closes that gap.
    """
    activity = zepp.get("activity", {})
    steps = zepp.get("steps") or activity.get("steps")
    active_kcal = activity.get("activeKcal")
    upstream_suspect = bool(activity.get("activeKcalSuspect", False))

    # AC-1/AC-4: upstream producer labelled this snapshot suspect -- no Boss-facing number.
    if upstream_suspect:
        return None, False, True

    # Local sanity: implausibly low activeKcal vs step count
    low_and_high_steps = (
        active_kcal is not None
        and active_kcal < ACTIVE_KCAL_SANITY_MIN
        and steps
        and steps > STEPS_SANITY_THRESHOLD
    )
    use_floor = (active_kcal is None) or low_and_high_steps

    if use_floor and steps and steps > STEPS_SANITY_THRESHOLD:
        safe_kcal = min(int(steps * KCAL_PER_STEP_FLOOR), KCAL_FLOOR_MAX)
    elif active_kcal is not None:
        safe_kcal = int(active_kcal)
        use_floor = False
    else:
        safe_kcal = 0
        use_floor = False

    goal = CALORIE_BMR + safe_kcal - CALORIE_DEFICIT
    return goal, use_floor, False


def apply_load_adjustment(exercises: list[dict], adj_pct: int) -> list[dict]:
    """Csökkenti az ismétlésszámot adj_pct%-kal (negatív érték = csökkentés)."""
    if adj_pct >= 0:
        return exercises
    factor = 1 + adj_pct / 100  # pl. -10% -> 0.9
    adjusted = []
    for ex in exercises:
        ex2 = dict(ex)
        reps = ex.get("reps_or_duration", "")
        if isinstance(reps, str) and "-" in reps:
            # tartomány pl. "8-12" -> mindkét végét csökkentjük
            parts = reps.split("-")
            try:
                lo = max(1, round(int(parts[0]) * factor))
                hi = max(lo, round(int(parts[1]) * factor))
                ex2["reps_or_duration"] = f"{lo}-{hi}"
                ex2["_adj"] = True
            except ValueError:
                pass
        elif isinstance(reps, (int, float)):
            ex2["reps_or_duration"] = max(1, round(reps * factor))
            ex2["_adj"] = True
        adjusted.append(ex2)
    return adjusted


def format_exercise_plan(session: dict, adj_pct: int) -> str:
    """Formázza az edzéstervet -- adj_pct alapján módosítja az ismétlésszámokat."""
    lines = []
    session_type = session.get("session_type", "")
    if session_type in ("rest", "mobility"):
        lines.append(f"Típus: {session_type}")
        if session.get("notes"):
            lines.append(session["notes"])
        return "\n".join(lines)

    exercises = session.get("exercises", [])
    if adj_pct < 0:
        exercises = apply_load_adjustment(exercises, adj_pct)

    for i, ex in enumerate(exercises, 1):
        name = ex.get("name", "?")
        sets = ex.get("sets", "")
        reps = ex.get("reps_or_duration", "")
        load = ex.get("load_scheme", "")
        notes = ex.get("notes", "")
        adj_mark = " *" if ex.get("_adj") else ""

        parts = [f"{i}. {name}"]
        if sets and reps:
            parts.append(f"{sets}x{reps}{adj_mark}")
        if load:
            parts.append(f"| {load}")
        if notes:
            parts.append(f"({notes})")
        lines.append("  " + " ".join(parts))

    if adj_pct < 0:
        lines.append(f"  (* {adj_pct:+d}% korrekció alkalmazva)")
    return "\n".join(lines)


def format_readiness_message(r: dict, session: dict | None, muscle_text: str, calorie_goal: int | None = None, calorie_floor_used: bool = False, calorie_suspect: bool = False) -> str:
    """3 blokk: 1) Zepp adatok  2) Elemzés  3) Edzésterv"""
    stress = r["stress"]
    sq = r.get("sleep_quality", {})
    sleep_h = r["sleep_min"] // 60
    sleep_m = r["sleep_min"] % 60
    adj = r.get("load_adjustment_pct", 0)

    icons = {"GREEN": "🟢", "YELLOW": "🟡", "RED": "🔴"}
    slp_icon = icons.get(sq.get("level", "GREEN"), "⚪")
    stress_icon = icons.get(stress["level"], "⚪")

    session_label = session.get("label", session.get("session_type", "?")) if session else "Nincs terv"
    is_rest = session and session.get("session_type") in ("rest", "mobility")

    lines = []

    # ── BLOKK 1: Zepp alvás adatok ──
    lines.append(f"── {r['date']} reggeli adatok ──")
    lines.append(f"{slp_icon} Alvás: {sleep_h}ó{sleep_m}p")
    lines.append(f"   Deep: {sq.get('deep_pct', 0):.0f}%  |  REM: {sq.get('rem_pct', 0):.0f}%")
    if sq.get("dur_avg"):
        lines.append(
            f"   Személyes átlag: {sq['dur_avg']}h / deep {sq.get('deep_avg', 0):.0f}% / REM {sq.get('rem_avg', 0):.0f}%"
            f"  ({sq.get('history_days', 0)} nap)"
        )
    lines.append(f"   HRV: {stress['hrv_today']:.2f}ms (delta {stress['hrv_delta']:+.2f}ms)")
    lines.append(f"   RHR: {stress['rhr_today']} bpm (delta {stress['rhr_delta']:+.0f})")

    # ── BLOKK 2: Elemzés ──
    lines.append("")
    lines.append("── Elemzés ──")
    lines.append(f"{stress_icon} Stressz: {stress['level']} ({stress['combined']}/4)")
    lines.append(f"{slp_icon} Alvás minőség: {sq.get('level', '?')} ({sq.get('score', 0)}/5)")

    if adj < 0:
        lines.append(f"⚠️  Terhelés-korrekció: {adj:+d}%")
        if sq.get("level") != "GREEN":
            lines.append(f"   ok: alvás {sq.get('level')} (deep/REM a személyes átlag alatt)")
        if stress["level"] != "GREEN":
            lines.append(f"   ok: stressz {stress['level']} (HRV/RHR eltérés)")
    else:
        lines.append("✅ Nincs korrekció -- alvás és stressz rendben")

    # Izomcsoport recovery (csak a releváns sorok)
    if muscle_text and not is_rest:
        muscle_lines = muscle_text.split("\n")
        recovery_lines = [l for l in muscle_lines[1:] if ("🟡" in l or "🔴" in l) and "◀" in l]
        if recovery_lines:
            lines.append("Izomcsoport recovery (mai session):")
            for ml in recovery_lines:
                lines.append(f"   {ml.strip()}")
        else:
            lines.append("✅ Minden érintett izomcsoport pihent")

    if calorie_suspect:
        # AC-1/AC-4 (WELL-027): upstream producer flagged activeKcal suspect -> no Boss-facing number
        lines.append("⚠️  Kalória-cél: kihagyva (Zepp activeKcal gyanús, producer jelölés)")
    elif calorie_goal is not None:
        floor_tag = " [floor-becslés]" if calorie_floor_used else ""
        lines.append(f"🍽️  Kalória-cél: {calorie_goal} kcal{floor_tag}")

    if r.get("max_hr_updated"):
        lines.append(f"📈 Max HR frissítve: {r['max_hr_updated']:.0f} bpm (új csúcs)")

    # ── BLOKK 3: Edzésterv ──
    lines.append("")
    lines.append(f"── Mai terv: {session_label} ──")
    if session:
        if session.get("duration_min"):
            lines.append(f"Időtartam: ~{session['duration_min']} perc")
        plan_text = format_exercise_plan(session, adj)
        if plan_text:
            lines.append(plan_text)
        form_cues = session.get("form_cues", [])
        if form_cues:
            lines.append("Forma:")
            for cue in form_cues:
                lines.append(f"  - {cue}")
    else:
        lines.append("Nincs mai terv a plan fájlban.")

    return "\n".join(lines)


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=str(date.today()))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true", help="Küld akkor is ha ma már ment")
    args = parser.parse_args()

    target = date.fromisoformat(args.date)
    flag = flag_path(target)

    if os.path.exists(flag) and not args.force:
        log.info("Ma már elment a readiness relay (%s). --force ha újra kell.", target)
        return

    zepp_file = zepp_path(target)
    if not os.path.exists(zepp_file):
        log.info("Nincs mai Zepp adat (%s), várakozás.", target)
        return

    with open(zepp_file, encoding="utf-8") as f:
        zepp = json.load(f)

    if zepp.get("status") != "ok":
        log.info("Zepp adat nem ok státuszú.")
        return

    sleep_end = zepp.get("sleep", {}).get("endAt")
    if not sleep_end:
        log.info("Még nincs sleep.endAt -- Dominik valószínűleg még alszik.")
        return

    log.info("Felkelés detektálva: %s -- readiness számolás indul.", sleep_end)

    readiness = run_readiness(target)
    if not readiness:
        log.error("Readiness kalkuláció sikertelen.")
        return

    session = today_session(target)
    session_label = session.get("label", session.get("session_type", "")) if session else ""
    muscle_text = run_muscle_recovery(target, session_label) if session_label else ""

    calorie_goal, calorie_floor_used, calorie_suspect = compute_calorie_goal(zepp)
    message = format_readiness_message(readiness, session, muscle_text, calorie_goal, calorie_floor_used, calorie_suspect)

    if args.dry_run:
        print("--- DRY RUN ---")
        print(message)
        print("--- END ---")
        return

    token = load_token()
    config = load_push_config()
    chat_id = config.get("chat_id")

    if not token or not chat_id:
        log.error("Hiányzó token vagy chat_id -- nem tud küldeni.")
        return

    ok = send_telegram(token, chat_id, message)
    if ok:
        log.info("Readiness Telegramon elküldve.")
        # Flag létrehozása
        with open(flag, "w") as f:
            f.write(datetime.now(timezone.utc).isoformat())
        os.chmod(flag, 0o600)
        # Inter-agent relay NoA-nak
        relay_content = (
            f"hibiki-readiness-relay [{target}]: stressz={readiness['stress']['level']}, "
            f"CTL={readiness['ctl']:.1f}, ATL={readiness['atl']:.1f}, "
            f"TSB={readiness['tsb']:+.1f}, "
            f"next_session={readiness['recovery']['next_session_readiness']}"
        )
        send_interagent(relay_content)
    else:
        log.error("Telegram küldés sikertelen.")


if __name__ == "__main__":
    main()
