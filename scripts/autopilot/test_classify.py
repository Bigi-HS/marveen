#!/usr/bin/env python3
"""Offline unit tests for the autopilot IDLE-GATE classifier.

Falsifying tests on the DANGEROUS side (lesson-isolation-gate-enforcement...):
the risky failure is a FALSE idle (agent goes silent while work waits), so most
tests assert that work is NOT hidden. Run: python3 scripts/autopilot/test_classify.py
"""
import sys
import time

from classify import classify, _fail_safe

NOW = 1_700_000_000.0
H = 3600.0


def card(id, status="planned", assignee="", desc="", age_h=0.0, priority="normal", title="t"):
    return {"id": id, "status": status, "assignee": assignee, "description": desc,
            "last_moved": NOW - age_h * H, "priority": priority, "title": title}


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

    print("\n" + ("ALL PASS" if ok else "SOME FAILED"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.path.insert(0, ".")
    raise SystemExit(main())
