#!/usr/bin/env python3
"""Mailbox-guard for Claudia's Gmail/Calendar scheduled watchdogs.

Motivation (SEC-029, 2026-08-04): the Google MCP was silently bound to a
different Google account for 2.5 days. Every API call returned HTTP 200 with
perfectly valid data -- from the wrong mailbox. The existing auth-error branch
in gmail-urgency-watchdog only fires on invalid_grant/401, so it never tripped.
"Valid but wrong" is the failure mode that hurts; a silent zero is a signal, not
a calm week.

Two deterministic checks, so the watchdog does not have to rely on model
judgement:

  identity   -- assert the connected account IS the expected one (primary check)
  zero-streak -- track consecutive empty results and flag an implausible run

The identity check is the real guard. The zero-streak is the backstop for
failure modes that keep the right account but break the query (bad filter,
label deleted, API shape change).

Usage:
  claudia-mailbox-guard.py identity <observed-account>
  claudia-mailbox-guard.py zero-streak <task-name> <result-count>
  claudia-mailbox-guard.py status
  claudia-mailbox-guard.py reset-incident

Exit codes:
  0 = OK
  1 = guard tripped, SEND the alert
  2 = usage error
  3 = guard tripped, alert SUPPRESSED (already reported) -- still abort the run,
      but stay silent on Telegram

Alerting is both rate-limited and capped. A wrong-account incident lasts until
someone fixes it, and these watchdogs run every 3-6h; a bare cooldown would still
drip forever. So: cooldown bounds the RATE, cap bounds the TOTAL per incident, and
a PASS is the reset edge that re-arms both for the next incident.
"""

import json
import os
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_PATH = os.path.join(REPO, "store", "claudia-mailbox-guard.json")

DEFAULTS = {
    # The account Claudia is supposed to be acting for. Not a secret -- an
    # assertion target. If a re-consent ever changes this legitimately, edit it
    # here deliberately rather than letting the guard drift silently.
    "expected_account": "dominik10023player@gmail.com",
    # Consecutive empty runs before an empty result is treated as suspicious.
    # Sized per cadence so a genuinely quiet stretch does not cry wolf:
    #   gmail-urgency-watchdog  every 3h -> 16 runs ~= 48h
    #   buccanier-label-watch   every 6h ->  8 runs ~= 48h
    #   claudia-napi-brief      daily    ->  3 runs ~= 72h
    "thresholds": {
        "gmail-urgency-watchdog": 16,
        "buccanier-label-watch": 8,
        "claudia-napi-brief": 3,
    },
    "default_threshold": 12,
    "streaks": {},
    # Alert budget for a single identity incident. cooldown = rate limit,
    # max_alerts = total ceiling. Without the cap a 3h watchdog would keep
    # nagging about the same unfixed account indefinitely.
    "alert_cooldown_seconds": 21600,  # 6h
    "alert_max_per_incident": 4,
    "incident": None,
}


def load_state():
    if not os.path.exists(STATE_PATH):
        return dict(DEFAULTS)
    try:
        with open(STATE_PATH) as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        # A corrupt state file must not wedge the watchdog. Fall back to
        # defaults; the identity check does not depend on stored state.
        return dict(DEFAULTS)
    for key, value in DEFAULTS.items():
        state.setdefault(key, value)
    return state


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)
    os.replace(tmp, STATE_PATH)


def normalize(account):
    return (account or "").strip().strip("<>").lower()


def _alert_budget(state, incident_key):
    """Decide whether this trip should page a human. Returns (send, note)."""
    now = int(time.time())
    incident = state.get("incident") or {}

    if incident.get("key") != incident_key:
        # New (or first) incident -- re-armed by the reset edge.
        incident = {"key": incident_key, "first_seen": now, "alerts": 0, "last_alert": 0}

    cooldown = state["alert_cooldown_seconds"]
    cap = state["alert_max_per_incident"]
    since_last = now - incident["last_alert"]

    if incident["alerts"] >= cap:
        note = "SUPPRESSED: alert cap reached (%d/%d for this incident)" % (
            incident["alerts"],
            cap,
        )
        send = False
    elif incident["alerts"] > 0 and since_last < cooldown:
        note = "SUPPRESSED: cooldown active (%dm of %dm elapsed, alert %d/%d sent)" % (
            since_last // 60,
            cooldown // 60,
            incident["alerts"],
            cap,
        )
        send = False
    else:
        incident["alerts"] += 1
        incident["last_alert"] = now
        note = "SEND: alert %d/%d for this incident" % (incident["alerts"], cap)
        send = True

    state["incident"] = incident
    save_state(state)
    return send, note


def cmd_identity(argv):
    if len(argv) != 1:
        print("usage: claudia-mailbox-guard.py identity <observed-account>")
        return 2
    state = load_state()
    expected = normalize(state["expected_account"])
    observed = normalize(argv[0])

    if observed == expected:
        if state.get("incident"):
            # Reset edge: the incident is over, re-arm the alert budget so the
            # next distinct failure pages a human again.
            print("NOTE: previous identity incident cleared, alert budget re-armed")
            state["incident"] = None
            save_state(state)
        print("PASS: mailbox identity matches (%s)" % expected)
        return 0

    if not observed:
        incident_key = "no-account-observed"
        print("FAIL: no account observed -- could not read the primary calendar id")
    else:
        incident_key = observed
        print("FAIL: WRONG ACCOUNT")
        print("  expected: %s" % expected)
        print("  observed: %s" % observed)
        print("ACTION: results here are another person's data -- do not read or summarise them")

    send, note = _alert_budget(state, incident_key)
    print(note)
    if send:
        print("ACTION: alert Boss + NoA, then abort the run")
        return 1
    print("ACTION: abort the run silently -- already reported, do not re-page")
    return 3


def cmd_zero_streak(argv):
    if len(argv) != 2:
        print("usage: claudia-mailbox-guard.py zero-streak <task-name> <result-count>")
        return 2
    task = argv[0]
    try:
        count = int(argv[1])
    except ValueError:
        print("usage: result-count must be an integer")
        return 2

    state = load_state()
    threshold = state["thresholds"].get(task, state["default_threshold"])
    entry = state["streaks"].get(task, {"consecutive_zero": 0, "last_nonzero": None})

    if count > 0:
        entry["consecutive_zero"] = 0
        entry["last_nonzero"] = int(time.time())
        state["streaks"][task] = entry
        save_state(state)
        print("OK: %d result(s), streak reset" % count)
        return 0

    entry["consecutive_zero"] = entry.get("consecutive_zero", 0) + 1
    state["streaks"][task] = entry
    save_state(state)
    streak = entry["consecutive_zero"]

    if streak < threshold:
        print("OK: empty run (%d/%d consecutive)" % (streak, threshold))
        return 0

    last = entry.get("last_nonzero")
    since = "never recorded" if not last else time.strftime(
        "%Y-%m-%d %H:%M", time.localtime(last)
    )
    print("SUSPICIOUS: %d consecutive empty runs (threshold %d)" % (streak, threshold))
    print("  task: %s" % task)
    print("  last non-empty run: %s" % since)
    print("ACTION: report it -- a silent zero is a signal, not a calm week")
    print("ACTION: check mailbox identity, the query filter, and that the label still exists")
    return 1


def cmd_reset_incident(argv):
    """Manually re-arm the alert budget, e.g. right after a re-consent."""
    state = load_state()
    if not state.get("incident"):
        print("no open identity incident -- alert budget already armed")
        return 0
    print("cleared incident: %s (%d alert(s) sent)" % (
        state["incident"].get("key"), state["incident"].get("alerts", 0)))
    state["incident"] = None
    save_state(state)
    return 0


def cmd_status(argv):
    state = load_state()
    print("expected account: %s" % state["expected_account"])
    print("state file: %s" % STATE_PATH)
    incident = state.get("incident")
    if incident:
        print("OPEN identity incident: %s (%d/%d alerts sent, first seen %s)" % (
            incident.get("key"),
            incident.get("alerts", 0),
            state["alert_max_per_incident"],
            time.strftime("%Y-%m-%d %H:%M", time.localtime(incident.get("first_seen", 0))),
        ))
    else:
        print("no open identity incident (alert budget armed)")
    if not state["streaks"]:
        print("no streak history recorded yet")
        return 0
    for task, entry in sorted(state["streaks"].items()):
        threshold = state["thresholds"].get(task, state["default_threshold"])
        last = entry.get("last_nonzero")
        last_str = "never" if not last else time.strftime(
            "%Y-%m-%d %H:%M", time.localtime(last)
        )
        print(
            "  %-26s zero-streak %d/%d, last non-empty %s"
            % (task, entry.get("consecutive_zero", 0), threshold, last_str)
        )
    return 0


COMMANDS = {
    "identity": cmd_identity,
    "zero-streak": cmd_zero_streak,
    "status": cmd_status,
    "reset-incident": cmd_reset_incident,
}


def main(argv):
    if not argv or argv[0] not in COMMANDS:
        print(__doc__)
        return 2
    return COMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
