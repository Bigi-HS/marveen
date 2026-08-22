# Hibiki Health Store -- Privacy Boundary Statement

**Location:** `agents/hibiki/store/` (gitignored, Hibiki-private)
**Spec:** `store/specs/hibiki-health-tracker-extension.md` (SEC-AC4 honest boundary)

---

## What this store contains

| File | Contents |
|------|----------|
| `hibiki-progress.json` | `weight_log`, `dexa_results`, `workout_log`, `form_feedback`, `plan_change_log` |
| `hibiki-supplements.json` | Supplement schedule + source/vendor (no dosage fields) |
| `nutrition_log.json` | Daily calorie + macro log (NUT-AC1 schema) |
| `supplement_adherence_log.json` | Daily per-supplement taken/skipped log (ADH-AC1 schema) |
| `plans/` | Weekly periodized training plans |

## Privacy guarantee (honest boundary)

Hibiki does NOT:
- Write health metrics (nutrition, adherence, DEXA, weight) to the memory API at any tier (hot/warm/cold/shared)
- Include raw or derived health metrics in inter-agent messages
- Write health metrics to the daily log
- Cache stats results

Store files are created with mode 0600 (owner read/write only) per SEC-AC4b.

**What this does NOT guarantee:** Hard architectural isolation. The shared Bearer token and flat JSON store mean any fleet agent with filesystem access can read these files. The `access_scope` mechanism is advisory, not enforced at the OS level. This system is single-user, locally hosted; the risk model accepts this limitation. Hard isolation requires a separate architectural spec.

## Write path (SEC-AC2/3/4b)

All writes go through `scripts/hibiki-health-write.py`:
- SEC-AC1 range validation before every write
- SEC-AC3 source field (`manual` | `vision-confirmed`) on every entry
- SEC-AC4b 0600 file permissions enforced at open+write time

## Stats (STAT-AC1 through STAT-AC4)

Computed on-demand by `scripts/hibiki-stats.py`. Never pre-stored, never cached.
Delivered via Hibiki's own Telegram channel only.

## Source values

| Value | Meaning |
|-------|---------|
| `manual` | Dominik stated values directly in text; no inference step |
| `vision-confirmed` | Hibiki read via vision/voice; Dominik explicitly confirmed values |
