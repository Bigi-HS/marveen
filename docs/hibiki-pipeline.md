# Hibiki token-free daily push pipeline

Deterministic, NON-LLM daily push for the **Hibiki** personal-trainer agent.
Reads a pre-generated structured training plan + supplement inventory and pushes
today's session and timed intake reminders to Hibiki's own Telegram channel
**without a running Claude session** (spec `store/specs/hibiki-personal-trainer.md`,
acceptance criteria B-AC1..B-AC4, C-AC1..C-AC3).

The design mirrors the token-outage bridge philosophy: the LLM agent (Hibiki)
generates the plan **once per mesocycle, with a token**; the daily delivery is a
plain Python script driven by system cron, so reminders arrive even when no
agent session is alive.

## Components

| File | Tracked? | Role |
|---|---|---|
| `scripts/hibiki-daily-push.py` | yes | the push script (stdlib only, NON-LLM) |
| `scripts/test_hibiki_daily_push.py` | yes | unit + integration tests (`python3 scripts/test_hibiki_daily_push.py`) |
| `scripts/hibiki-examples/` | yes | sanitized templates seeded into the private store |
| `scripts/hibiki-install-push.sh` | yes | deploy: seed store (no clobber) + install cron |
| `agents/hibiki/store/` | **no** (gitignored) | the live private store -- plans, progress, supplements |

## Private store layout (`agents/hibiki/store/`)

Gitignored. Holds sensitive health data; files are `chmod 600`.

```
agents/hibiki/store/
  plans/hibiki-plan-YYYY-Www.json   # one weekly plan file per ISO week (4 per mesocycle)
  hibiki-supplements.json            # supplement inventory (NO dosage field)
  hibiki-progress.json               # weight / dexa / workout / form / plan_change log
  push-config.json                   # { chat_id, session_push_time, reminder_tolerance_min }
  signature.txt                      # the G-AC1 signature phrase (placeholder until confirmed)
  .push-state-YYYY-MM-DD.json        # per-day dedupe state (written by the push script)
  push.log                           # cron stdout/stderr (counts only, never health data)
```

## Data model

### Weekly plan (`hibiki-plan-YYYY-Www.json`)

```
plan_id            string    "2026-W24"
generated_at       ISO8601
goals              object    { primary, secondary, tertiary }
nutrition_targets  object    { calories, protein_g, updated_at, notes }
week_notes         string
weekly_sessions    array     of Session
```

Session:
```
day             "monday".."sunday"
session_type    "strength" | "mobility" | "cardio" | "rest"   (never "deload")
scheduled_time  "HH:MM" | null   (Claudia-confirmed; null until confirmed)
duration_min    int
deload          bool             (true = run at deload intensity; single source of truth)
exercises       array  of { name, sets, reps_or_duration, load_scheme, notes }
form_cues       array  of string (latest form-feedback refs)
```

Deload weeks are expressed **only** via `deload: true` on the sessions; the
string `"deload"` is never a `session_type` value (resolves the spec v1 dual-flag
ambiguity, A-AC4). A 4-week mesocycle has the 4th week's training sessions all
flagged `deload: true`.

### Progress store (`hibiki-progress.json`)

```
weight_log       [{ date, kg }]
dexa_results     [{ date, body_fat_pct, lean_mass_kg, bone_density? }]
workout_log      [{ date, plan_id, session_type, completed, notes }]
form_feedback    [{ exercise, timestamp, findings: [{ issue, severity, cue }] }]   severity: critical|advisory|note
plan_change_log  [{ timestamp, trigger, change_description, confirmed_by }]
```

### Supplement inventory (`hibiki-supplements.json`)

```
name             string
source_vendor    string
procurement_date ISO date
intake_schedule  [{ time: "HH:MM", days: "daily" | ["mon","tue",...], notes }]
```

There is **no `dosage` field anywhere** in the schema (spec C-AC1, F-AC2). The
push only ever emits a supplement *name* + "time to take" message.

## Push behavior (one cron tick)

The script is invoked every 5 minutes. Each tick it decides what is due **now**
and sends it once; a per-day state file (`.push-state-YYYY-MM-DD.json`) dedupes
so re-runs never double-send.

1. **Daily session push** at/after `session_push_time` (default 06:30), once per
   day: today's session (exercises, sets/reps), the nutrition target, and an
   overview of today's intake schedule. A rest day sends a short rest message
   with no exercise list (B-AC4). A missing/corrupt plan sends a single
   "plan unavailable, manual check needed" alert (edge case).
2. **Timed intake reminders** (B-AC3): each supplement intake time fires its own
   reminder within `reminder_tolerance_min` (default ±5 min) of the scheduled
   time -- name + "time to take" only, no dosage.

Adding a supplement to the inventory produces reminders on the next tick with no
code change (C-AC2).

## Signature deploy blocker (G-AC1) -- enforced in code

`signature.txt` holds Hibiki's closing signature phrase. Until Dominik/Genesis
confirm it, the file contains a placeholder. **While the signature is empty or
contains "PLACEHOLDER", the script refuses to send any live push** and logs
`signature not configured (G-AC1 deploy blocker) -- push suppressed`. This makes
the spec's deploy blocker a hard runtime guard, not just a checklist item.
`--dry-run` bypasses the guard (it never sends anyway) so the plan can be
previewed before the phrase is set.

## Privacy (C-AC3 / F-AC3)

- Supplement names and any health data are **never** written to stdout/stderr.
  The script logs counts and opaque keys only; `push.log` is safe to read.
- The store is the agent-private `agents/hibiki/store/` (gitignored, `chmod 600`).
- Applegate has standing audit rights over this store (read/tier) but must not
  forward the data to other agents without Dominik's explicit instruction.

## Deploy (launch step -- not run during development)

```bash
# 1. provisioning puts the bot token in agents/hibiki/.claude/channels/telegram/.env
# 2. seed the store + install the every-5-min cron entry:
scripts/hibiki-install-push.sh
# 3. edit agents/hibiki/store/push-config.json  -> real chat_id
# 4. edit agents/hibiki/store/signature.txt     -> confirmed signature (removes the block)
```

Seeding never overwrites an existing file, so re-running is safe. Preview without
sending:

```bash
python3 scripts/hibiki-daily-push.py --dry-run --now 2026-06-08T06:35
```

### If cron is unavailable (WSL / no systemd)

The spec accepts a `fleet-supervisor.sh` watchdog-pattern daemon as an
equivalent always-on driver. Register the push as a periodic tick there (call
the same script every 5 min) instead of crontab. Either way the guarantee is the
same: the push runs independent of any Claude session. `~/.claude/scheduled-tasks/`
is explicitly **not** acceptable -- those only fire inside a live session.
