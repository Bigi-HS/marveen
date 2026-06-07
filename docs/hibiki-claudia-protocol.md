# Hibiki <-> Claudia scheduling protocol

Spec: `store/specs/hibiki-personal-trainer.md` section D (D-AC1..D-AC3) + F-AC3.
Module: `scripts/hibiki-claudia-protocol.py` (stdlib only, no IO/network).

Hibiki owns training plans; Claudia owns Dominik's Google Calendar. Hibiki
**never** writes to the calendar directly. It proposes session slots; Claudia
confirms or rejects them; Hibiki folds the confirmed times back into the plan.

## Message flow

```
Hibiki  --schedule_request-->      Claudia        (D-AC1: propose, never place)
Claudia --schedule_confirmation--> Hibiki         (confirmed[] + rejected[])
Hibiki  --schedule_request-->      Claudia        (re-proposal for rejected days, D-AC2)
```

A plan is **not finalized** until every schedulable session has a Claudia-
confirmed time. `scheduled_time` is `null` until then; `preferred_time` carries
Hibiki's initial wish.

## Wire shapes (D-AC3)

`schedule_request` (hibiki -> claudia):

```json
{
  "type": "schedule_request",
  "from": "hibiki",
  "week": "2026-W24",
  "sessions": [
    {"day": "monday", "preferred_time": "07:00", "duration_min": 60,
     "session_type": "strength", "flexibility_window": "06:00-09:00"}
  ]
}
```

`schedule_confirmation` (claudia -> hibiki):

```json
{
  "type": "schedule_confirmation",
  "from": "claudia",
  "sessions": [{"day": "monday", "confirmed_time": "07:30", "calendar_event_id": "..."}],
  "rejected": [{"day": "wednesday", "reason": "conflict: existing event 18:00-19:30"}]
}
```

Required fields are enforced; additional benign fields are allowed. Only
`strength` / `mobility` / `cardio` sessions are proposed -- `rest` days are not
placed on the calendar.

## Privacy boundary (F-AC3)

A schedule message must carry **only** scheduling fields. `scan_for_health_data`
recurses the whole payload and the validators reject any message that smuggles
supplement / DEXA / weight / nutrition / progress data into a Claudia-bound
message. This is enforced in code, not just review.

## API

| Function | Purpose |
| --- | --- |
| `validate_schedule_request(msg)` | -> list of error strings (`[]` = valid) |
| `validate_schedule_confirmation(msg)` | -> list of error strings |
| `scan_for_health_data(payload)` | -> key-paths of any health data found |
| `build_schedule_request(plan, week_key)` | extract schedulable slots from a plan (D-AC1) |
| `apply_confirmation(plan, confirmation)` | fold confirmed times in; report rejections; `finalized` flag (D-AC1) |
| `reconcile_rejections(plan, rejected, busy_windows)` | re-propose around the day's busy windows or flag `no_slot` (D-AC2) |
| `propose_alternative(session, busy_windows)` | earliest non-conflicting start in the flexibility window |

`apply_confirmation` does not mutate the input plan; it returns a new plan dict.

## Rejection handling (D-AC2)

On rejection Hibiki never silently drops a session. `reconcile_rejections` takes
the day's busy windows (existing calendar events) and returns:
- `reproposal`: a second `schedule_request` for days where a free slot was found
  inside the flexibility window;
- `no_slot`: days with no fitting window -- Hibiki surfaces these to Dominik on
  Telegram ("no slot available <day>").

## Transport

This module is pure logic. The actual inter-agent send/receive uses the fleet
dashboard message API (`POST /api/messages`, `from`/`to`/`content`); the JSON
payloads above go in `content`. Hibiki validates inbound confirmations with
`validate_schedule_confirmation` before applying them.

## Tests

`scripts/test_hibiki_claudia_protocol.py` -- 25 stdlib unittests (validators,
health-scan, build, apply/finalize, rejection reconcile). Run:
`python3 scripts/test_hibiki_claudia_protocol.py`.
