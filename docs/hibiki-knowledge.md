# Hibiki operating knowledge (evidence base + plan-generation contract)

Version-controlled source of truth for the knowledge Hibiki (the personal-trainer
agent) must hold as **hard knowledge** in its `CLAUDE.md`, plus the contract that
ties Hibiki's plan generation to the token-free push pipeline
(`docs/hibiki-pipeline.md`). Hibiki's `CLAUDE.md` is gitignored (live-edited per
agent), so this doc keeps the knowledge reproducible if the agent is re-scaffolded.

Source: Scout research addendum in `store/specs/hibiki-personal-trainer.md`
(2026-06-07). Cite frameworks by name; do NOT invent study authors/DOIs.

---

## 1. Plan-generation contract (ties to the push pipeline)

Hibiki generates the plan **with a token**, once per mesocycle, and writes it into
the agent-private store in the EXACT schema the NON-LLM cron push reads. If the
schema or paths drift, the token-free push breaks. Authoritative schema + paths:
`docs/hibiki-pipeline.md`.

- One weekly plan file per ISO week: `agents/hibiki/store/plans/hibiki-plan-YYYY-Www.json`.
- A mesocycle = **4 weekly files**; week 4's training sessions are all `deload: true`.
- `session_type` is one of `strength | mobility | cardio | rest` -- **never** `"deload"`
  (deload is the boolean flag, single source of truth).
- At least **2 mobility/flexibility sessions per week** (goal: flexibility).
- `nutrition_targets` carries `calories`, `protein_g`, `updated_at`, `notes`.
- Supplement inventory: `agents/hibiki/store/hibiki-supplements.json`, fields
  `name / source_vendor / procurement_date / intake_schedule[]`. **No dosage field, ever.**
- Progress + change history: `agents/hibiki/store/hibiki-progress.json`
  (`weight_log / dexa_results / workout_log / form_feedback / plan_change_log`).
- The daily delivery is the **system-cron push script**, NOT `~/.claude/scheduled-tasks/`
  (those only fire inside a live session = not token-free). Hibiki's only job at
  delivery is to keep the upcoming weeks' plan files present and well-formed.

---

## 2. Periodization (block model, Israetel / RP)

Default to **block periodization** for an intermediate+ lifter; fall back to a
simpler linear model if Dominik is not advanced (overcomplex plans get skipped --
the #1 failure mode).

- **Accumulation** (3-4 wk): high volume, moderate intensity -- build work capacity.
- **Intensification** (3-4 wk): moderate volume, high intensity -- convert to strength.
- **Deload/realization** (1 wk): 40-60% volume reduction, intensity maintained.

**Volume landmarks per muscle group per week (MEV/MAV/MRV):**
- MEV (minimum effective) ~8-10 sets -- where gains start.
- MAV (max adaptive) ~12-20 sets -- optimal adaptation zone.
- MRV (max recoverable) ~20-25 sets -- above = overtraining risk.

**Deload triggers (whichever first):** (1) scheduled every 3-4 loading weeks;
(2) reactive -- 2+ consecutive sessions of performance decline, elevated RPE at the
same load, or reported fatigue/motivation drop.

**RPE/RIR scale (embed in session design):**
- RPE 6-7 (RIR 3-4): warm-up / deload range.
- RPE 7-8 (RIR 2-3): optimal volume-work zone -> accumulation main sets.
- RPE 9-10 (RIR 0-1): intensity work -> intensification/realization.

---

## 3. ACSM 2026 Position Stand (key numbers)

First update in 17 years; 137 studies; Stuart Phillips lead (April 2026).
- Hypertrophy: ~10 sets/muscle group/week minimum; dose-response beyond that.
- Frequency: train each major muscle group at least 2x/week.
- Load: strength = 80%+ 1RM, 2-3 sets/exercise; hypertrophy = any load if effort + volume controlled.
- Rep range has no independent hypertrophy effect when effort + volume are equated.
- Training to failure is NOT superior vs stopping 2-3 reps short (RIR 2-3).
- Consistency > complexity: simple plans executed well beat complex plans skipped.

---

## 4. Nutrition targets (advisory, not prescription)

- **Protein (ISSN):** 1.4-2.0 g/kg/day for exercising individuals; use the **upper end
  1.8-2.2 g/kg/day** for simultaneous fat loss + muscle retention. Protein is the
  primary modulator of lean-mass retention in a deficit.
- **TDEE:** Mifflin-St Jeor BMR x activity multiplier (1.2-1.9). Present as an
  ESTIMATE; correct from the actual weight trend, not the formula.
- **Fat-loss deficit:** 200-500 kcal/day below TDEE (sustainable; bigger risks lean mass).
- Concurrent resistance + cardio does not blunt hypertrophy when protein is adequate.

---

## 5. DEXA interpretation protocol

Extract per scan: body fat % (trend > absolute), lean mass kg (absolute + delta),
bone density T-score (track, do NOT interpret medically -- flag changes to Dominik),
visceral fat if reported (note trend only).

- Minimum 2 scans for a trend, 3+ for reliable. Compare like-for-like (time of day,
  hydration, facility). 6-12 week intervals (shorter = noise).
- Trigger: lean mass declining despite training -> raise protein or reduce deficit.
- Trigger: body fat % flat after 6+ weeks -> adjust deficit or activity.

---

## 6. Form-cue library (text fallback when Big Ben video analysis is unavailable)

- **Squat:** knee cave -> "push knees out"; forward lean -> "chest up, brace harder"; depth -> "hips below parallel".
- **Deadlift:** rounding -> "chest up, lat engagement"; bar drift -> "keep the bar close".
- **Bench:** wrist angle -> "wrists straight"; + arch stability, scapular retraction.
- **OHP:** bar path forward -> "head back as the bar passes"; watch elbow flare.
- **Row:** elbow flare -> "elbows close to body"; lumbar rounding -> brace.

Severity (form_feedback schema): `critical` (injury risk, fix before next session) |
`advisory` (technique degradation, address within 1-2 sessions) | `note` (minor).

---

## 7. Source hierarchy (what Hibiki may cite)

- **Tier 1 (cite by name):** ACSM 2026 Position Stand (Phillips et al.); ISSN Position
  Stand on Protein (2017, consensus 2024); Renaissance Periodization MEV/MAV/MRV
  (Israetel); RPE/RIR scale.
- **Tier 2 (cite as framework, not a specific paper):** Schoenfeld hypertrophy
  research; ACSM fat-loss + muscle-preservation guidelines; ISSN HMB Position Stand (2024).
- **Tier 3 (methodology only, no citation):** DEXA interpretation standards; pose-estimation methodology.
- **Never cite:** Reddit, fitness blogs, anecdotal coaching, YouTube.

Discipline rule: every recommendation states ONE reason -- a Tier-1/2 framework or a
named principle (progressive overload, specificity, deload). Never fabricate authors/DOIs.

---

## 8. Safety / medical boundary (hard rule)

Hibiki never gives dosage advice, drug-interaction analysis, diagnosis, or claims a
supplement treats a condition. Fixed response when asked for dosage guidance:

> "Bevitel-emlékeztetőket vezetek, nem dózisokat. Ehhez kérdezd a kezelőorvosodat vagy a termék címkéjét."

The supplement inventory holds no dosage field; no numeric dosage appears in any message.

---

## 9. Privacy / governance

Supplement inventory, DEXA, weight log, and form feedback live under
`agents/hibiki/store/` and are Applegate-governance sensitive. Hibiki must not put
health data in inter-agent messages except: **Claudia** (scheduling only -- day +
session_type + time window, no metrics) and **Big Ben** (video URL only, no metrics).
Applegate has standing read/tier audit rights but must not forward the data to other
agents without Dominik's explicit instruction. Never log health data to stdout/stderr.
