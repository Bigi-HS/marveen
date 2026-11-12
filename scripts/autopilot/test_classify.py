#!/usr/bin/env python3
"""Offline unit tests for the autopilot IDLE-GATE classifier.

Falsifying tests on the DANGEROUS side (lesson-isolation-gate-enforcement...):
the risky failure is a FALSE idle (agent goes silent while work waits), so most
tests assert that work is NOT hidden. Run: python3 scripts/autopilot/test_classify.py
"""
import os
import sys
import tempfile
import time

from classify import classify, _fail_safe, is_frozen, parse_keep_list, _read_freeze_state

NOW = 1_700_000_000.0
H = 3600.0


def card(id, status="planned", assignee="", desc="", age_h=0.0, priority="normal", title="t",
         boss_waiting=0):
    return {"id": id, "status": status, "assignee": assignee, "description": desc,
            "last_moved": NOW - age_h * H, "priority": priority, "title": title,
            "boss_waiting": boss_waiting}


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    return cond


def main():
    ok = True

    # 1. Empty board -> idle_ok true.
    r = classify([], "dave", NOW)
    ok &= check("empty board -> idle", r["idle_ok"] is True)

    # 2. An agent's own fresh open card -> BUSY, listed in MINE.
    r = classify([card("c1", assignee="dave", age_h=1)], "dave", NOW)
    ok &= check("own card -> busy", r["idle_ok"] is False and r["counts"]["mine"] == 1)

    # 3. Own card with a FRESH awaiting marker (age<48h) -> PARKED, idle.
    r = classify([card("c2", assignee="dave", desc="awaiting-dominik", age_h=10)], "dave", NOW)
    ok &= check("fresh awaiting -> parked+idle", r["idle_ok"] is True and r["counts"]["parked"] == 1)

    # 4. CRIT (FI-01): own card with a STALE awaiting marker (age>48h) -> NUDGEABLE?
    #    For an owner, a stale marker means the card is actionable again -> MINE, NOT idle.
    r = classify([card("c3", assignee="dave", desc="awaiting-dominik", age_h=60)], "dave", NOW)
    ok &= check("stale awaiting (own) -> busy, marker expired",
                r["idle_ok"] is False and r["counts"]["mine"] == 1)

    # 5. repro-blocked marker parks for 72h, not 48h.
    r = classify([card("c4", assignee="dave", desc="repro-blocked: needs phone", age_h=60)], "dave", NOW)
    ok &= check("repro-blocked fresh at 60h -> parked", r["idle_ok"] is True)
    r = classify([card("c4", assignee="dave", desc="repro-blocked: needs phone", age_h=80)], "dave", NOW)
    ok &= check("repro-blocked stale at 80h -> busy", r["idle_ok"] is False)

    # 6. Orchestrator sees a peer-owned STALE card as NUDGEABLE (>24h).
    r = classify([card("c5", assignee="hibiki", age_h=48)], "marveen", NOW)
    ok &= check("orch: stale peer card -> nudgeable", r["counts"]["nudgeable"] == 1 and not r["idle_ok"])

    # 7. Orchestrator: peer-owned FRESH card (<24h) -> parked, idle.
    r = classify([card("c6", assignee="hibiki", age_h=5)], "marveen", NOW)
    ok &= check("orch: fresh peer card -> parked+idle", r["idle_ok"] is True)

    # 8. Non-orchestrator does NOT pick up peer-owned cards at all.
    r = classify([card("c7", assignee="hibiki", age_h=100)], "dave", NOW)
    ok &= check("non-orch ignores peer cards -> idle", r["idle_ok"] is True)

    # 9. Orchestrator adopts an unassigned STALE card as nudgeable.
    r = classify([card("c8", assignee="", age_h=100)], "marveen", NOW)
    ok &= check("orch: unassigned stale -> nudgeable", r["counts"]["nudgeable"] == 1 and not r["idle_ok"])

    # 10. Closed cards never count.
    r = classify([card("c9", status="done", assignee="dave", age_h=1)], "dave", NOW)
    ok &= check("done card ignored -> idle", r["idle_ok"] is True)

    # 11. INV2 fail-safe: error envelope is never idle.
    fs = _fail_safe("dave", "boom")
    ok &= check("fail-safe -> never idle", fs["idle_ok"] is False and fs["error"] == "boom")

    # 12. Unparseable timestamp with a marker must NOT hide the card (age=huge -> expired).
    c = card("c10", assignee="dave", desc="awaiting-dominik")
    c["last_moved"] = "not-a-number"
    c.pop("updated_at", None)
    r = classify([c], "dave", NOW)
    ok &= check("bad timestamp + marker -> treated ancient -> busy", r["idle_ok"] is False)

    # 13. FLAG-2 (Thor PR#882): a bare TG-reference must NOT park a card (false-idle).
    r = classify([card("c11", assignee="dave", desc="TG9452 alapjan kesz", age_h=1)], "dave", NOW)
    ok &= check("bare TG-ref -> NOT parked -> busy", r["idle_ok"] is False and r["counts"]["mine"] == 1)

    # 14. FLAG-3: a deliberate 'nyaral' awaiting-phrase DOES park (documents intended match).
    r = classify([card("c12", assignee="dave", desc="Dr. Stone nyaral, visszateres utan", age_h=1)], "dave", NOW)
    ok &= check("nyaral phrase -> parked (intended)", r["idle_ok"] is True and r["counts"]["parked"] == 1)

    # --- Piece 5 (card f4921a38): planning-freeze awareness (NoA option A) ---
    # A frozen agent goes idle_ok=True even with its own fresh open card; the TG\d
    # drop + sec3 marker-expiry stay untouched (orthogonal new capability, not a revert).

    # 15. Frozen agent with a live own card -> idle (frozen short-circuit), frozen=True.
    r = classify([card("f1", assignee="dave", age_h=1)], "dave", NOW, frozen=True)
    ok &= check("frozen agent -> idle despite own card",
                r["idle_ok"] is True and r.get("frozen") is True
                and r["counts"]["mine"] == 0)

    # 16. Not frozen (default) still drives the same card -> busy, frozen=False.
    r = classify([card("f1", assignee="dave", age_h=1)], "dave", NOW)
    ok &= check("not frozen -> busy, frozen flag present+false",
                r["idle_ok"] is False and r.get("frozen") is False)

    # 17. is_frozen pure predicate mirrors the server freeze contract.
    keep = {"claudia", "hibiki"}
    ok &= check("is_frozen: enabled + not in keep -> True", is_frozen(True, keep, "dave") is True)
    ok &= check("is_frozen: enabled + in keep -> False", is_frozen(True, keep, "hibiki") is False)
    ok &= check("is_frozen: disabled -> False", is_frozen(False, keep, "dave") is False)

    # 18. parse_keep_list mirrors the shell/server parser (comments + blanks dropped,
    #     first token taken, empty-after-filter -> DEFAULT_KEEP).
    ok &= check("parse_keep_list: ids parsed",
                parse_keep_list("claudia\n# note\n\nhibiki extra") == {"claudia", "hibiki"})
    ok &= check("parse_keep_list: None -> default", parse_keep_list(None) == {"claudia", "hibiki"})
    ok &= check("parse_keep_list: all-comments -> default",
                parse_keep_list("# only comments\n") == {"claudia", "hibiki"})

    # 19. _read_freeze_state: fail-safe direction is NOT frozen (keep driving) when
    #     uncertain -- the dangerous direction for this module is a FALSE idle.
    with tempfile.TemporaryDirectory() as d:
        flag = os.path.join(d, "planning-freeze.enabled")
        keepf = os.path.join(d, "planning-freeze-keep.txt")
        # flag absent -> never frozen.
        ok &= check("freeze-state: no flag -> not frozen",
                    _read_freeze_state("dave", flag, keepf) is False)
        # flag present, keep-file absent -> DEFAULT_KEEP fallback; dave frozen, hibiki not.
        open(flag, "w").close()
        ok &= check("freeze-state: flag + default keep -> dave frozen",
                    _read_freeze_state("dave", flag, keepf) is True)
        ok &= check("freeze-state: flag + default keep -> hibiki not frozen",
                    _read_freeze_state("hibiki", flag, keepf) is False)
        # explicit keep-file listing dave -> dave not frozen.
        with open(keepf, "w") as fh:
            fh.write("dave\nclaudia\n")
        ok &= check("freeze-state: keep-file lists dave -> not frozen",
                    _read_freeze_state("dave", flag, keepf) is False)

    # 20. (Chad #964 fail-safe) flag present but keep-file UNREADABLE (not merely
    #     absent) -> OSError -> NOT frozen (drive), since FALSE idle is dangerous.
    #     Simulated with a directory at the keep-path: exists()=True, open() raises
    #     IsADirectoryError (an OSError subclass).
    with tempfile.TemporaryDirectory() as d:
        flag = os.path.join(d, "planning-freeze.enabled")
        open(flag, "w").close()
        keep_dir = os.path.join(d, "keep-as-dir")
        os.mkdir(keep_dir)  # unreadable-as-file -> OSError on open
        ok &= check("freeze-state: keep-file OSError -> not frozen (fail-safe busy)",
                    _read_freeze_state("dave", flag, keep_dir) is False)

    # --- Card 9fb626a2: structured boss_waiting=1 flag honouring (NoA threshold=7d) ---
    # A card with the structured DB flag boss_waiting=1 is waiting on the Boss, not on
    # the worker. Unlike the text awaiting-marker (which auto-expires at 48h), this flag
    # is an explicit, non-rotting signal: the OWNER never drives it, and only the
    # ORCHESTRATOR surfaces it, and only after it has been unmoved > 7 days. The sec3
    # text-marker expiry (Thor PR#882 FLAG-2) is untouched -- this is an orthogonal
    # structured override, not a revert.
    BW_H = 7 * 24.0

    # 21. (THE FIX, ff15559d) own boss_waiting=1 card with an EXPIRED awaiting-text
    #     (67 days) -> PARKED, NOT mine. Pre-fix this fell into MINE -> false TICK_DRIVE.
    r = classify([card("bw1", assignee="dave", desc="awaiting-dominik", age_h=67 * 24,
                       boss_waiting=1)], "dave", NOW)
    ok &= check("boss_waiting owner + expired marker -> parked, not mine",
                r["idle_ok"] is True and r["counts"]["mine"] == 0 and r["counts"]["parked"] == 1)

    # 22. own boss_waiting=1 card, fresh, no marker -> PARKED (not mine).
    r = classify([card("bw2", assignee="dave", age_h=2, boss_waiting=1)], "dave", NOW)
    ok &= check("boss_waiting owner fresh -> parked",
                r["idle_ok"] is True and r["counts"]["parked"] == 1)

    # 23. A worker never nudges its own boss_waiting card even when very stale (>7d):
    #     it waits on the Boss, not on the worker -> still PARKED, never nudgeable.
    r = classify([card("bw3", assignee="dave", age_h=30 * 24, boss_waiting=1)], "dave", NOW)
    ok &= check("boss_waiting worker-owned >7d -> parked (worker never nudges)",
                r["idle_ok"] is True and r["counts"]["nudgeable"] == 0)

    # 24. Orchestrator surfaces a stale (>7d) boss_waiting card as NUDGEABLE so it
    #     reaches the morning brief aging-flag -- the escalation path.
    r = classify([card("bw4", assignee="dave", age_h=8 * 24, boss_waiting=1)], "marveen", NOW)
    ok &= check("orch: boss_waiting >7d -> nudgeable (escalate)",
                r["counts"]["nudgeable"] == 1 and not r["idle_ok"])

    # 25. Orchestrator does NOT surface a boss_waiting card younger than 7 days ->
    #     parked, idle (no sub-weekly Boss nag).
    r = classify([card("bw5", assignee="dave", age_h=3 * 24, boss_waiting=1)], "marveen", NOW)
    ok &= check("orch: boss_waiting <7d -> parked+idle (no nag)",
                r["idle_ok"] is True and r["counts"]["parked"] == 1)

    # 26. A non-orchestrator worker still ignores a PEER's boss_waiting card entirely.
    r = classify([card("bw6", assignee="hibiki", age_h=30 * 24, boss_waiting=1)], "dave", NOW)
    ok &= check("non-orch ignores peer boss_waiting card -> idle",
                r["idle_ok"] is True and r["counts"]["parked"] == 0)

    # 27. boss_waiting=0 is unaffected: an expired marker still falls into MINE
    #     (guards against over-parking -- the flag must be the ONLY trigger).
    r = classify([card("bw7", assignee="dave", desc="awaiting-dominik", age_h=67 * 24,
                       boss_waiting=0)], "dave", NOW)
    ok &= check("boss_waiting=0 + expired marker -> busy (unchanged)",
                r["idle_ok"] is False and r["counts"]["mine"] == 1)

    # 28. Truthy variants of the flag (int 1, bool True, str "1") all park for the owner;
    #     falsey variants (0, "0", "", None) do not.
    for val in (1, True, "1"):
        r = classify([card("bwT", assignee="dave", age_h=2, boss_waiting=val)], "dave", NOW)
        ok &= check(f"boss_waiting truthy {val!r} -> parked", r["counts"]["parked"] == 1)
    for val in (0, "0", "", None):
        r = classify([card("bwF", assignee="dave", age_h=2, boss_waiting=val)], "dave", NOW)
        ok &= check(f"boss_waiting falsey {val!r} -> mine", r["counts"]["mine"] == 1)

    # 29. Orchestrator owns its OWN stale boss_waiting card -> it escalates that too.
    r = classify([card("bw8", assignee="marveen", age_h=10 * 24, boss_waiting=1)], "marveen", NOW)
    ok &= check("orch owns stale boss_waiting -> nudgeable",
                r["counts"]["nudgeable"] == 1 and not r["idle_ok"])

    print("\n" + ("ALL PASS" if ok else "SOME FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.path.insert(0, ".")
    raise SystemExit(main())
