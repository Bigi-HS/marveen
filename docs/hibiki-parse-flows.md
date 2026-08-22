# Hibiki Parse Flows -- SEC-AC2 Confirm-Loop Specification

**Spec reference:** `store/specs/hibiki-health-tracker-extension.md` PARSE-AC1 through PARSE-AC5, SEC-AC2/3
**Implemented by:** behavioral instructions in `agents/hibiki/CLAUDE.md` (gitignored live-edit)
**Write tool:** `scripts/hibiki-health-write.py` (SEC-AC1/3/4b enforced)

---

## Why a confirm-loop is mandatory for all non-manual inputs

Image-based portion estimation produces systematic bias (not random errors) under research conditions. A "complete" 4-field extraction can still be 30-50% wrong on caloric value due to unresolvable portion-size ambiguity. A confidence score does not capture systematic bias; only Dominik can catch it. Silent auto-save on a systematically wrong value is worse than missing data.

Exception: `source: manual` (Dominik states values directly in text) -- the text itself is the confirmation.

---

## PARSE-AC2: Calorie app screenshot

**Trigger:** Dominik sends an image that appears to be a food-tracking app (MyFitnessPal, Cronometer, Yazio, Naplóm, or similar).

**Flow:**
1. Hibiki reads image via vision inference, extracts: `total_calories`, `protein_g`, `carbs_g`, `fat_g` (and `fiber_g` if visible).
2. Hibiki presents: "Kiolvasom: 1850 kcal / 165g F / 190g SZH / 42g ZS -- stimmel?"
3. Dominik confirms ("igen"), corrects specific values, or rejects.
4. SEC-AC1 range validation runs on the confirmed values. If out-of-range: Hibiki reports the anomaly, asks for corrected value, does NOT write.
5. On confirmation: `hibiki-health-write.py nutrition --date YYYY-MM-DD --calories N --protein N --carbs N --fat N [--fiber N] --source vision-confirmed`

**Edge cases:**
- Multiple days visible on screen: ask Dominik which date to log. Do not auto-log all visible dates.
- Unreadable image (blank/low quality): report failure, ask to retype or resend. Do NOT write a zero-valued entry.
- Dominik rejects the read entirely: do not write anything; offer manual entry path.

---

## PARSE-AC3: DEXA scan image or PDF

**Trigger:** Dominik sends a DEXA scan document (image or PDF).

**Extracted fields:** `body_fat_pct`, `fat_mass_kg`, `lean_mass_kg`, `vat_area_cm2` (if present), `bone_density` (if present), scan date.

**Flow:**
1. Hibiki reads via vision/PDF inference.
2. **Duplicate check:** compare extracted scan date against existing `dexa_results` entries. If date matches existing entry: warn ("Ez a dátum már szerepel az adatbázisban -- ez egy új scan vagy az előző újraküldése?") before presenting values.
3. Hibiki presents extracted values for confirmation.
4. SEC-AC1 range validation on confirmed values.
5. On confirmation: `hibiki-health-write.py dexa --date YYYY-MM-DD --body-fat-pct N --fat-mass-kg N --lean-mass-kg N [--vat-area-cm2 N] [--bone-density N] --source vision-confirmed`

**Edge cases:**
- >5% body_fat_pct change from previous scan within 60 days: flag as suspicious before writing ("Ez nagy változás rövid idő alatt -- megerősíted hogy ez egy új scan és nem az előző újraküldése?").
- Bone density present: record it but do NOT interpret medically. Flag changes to Dominik.

---

## PARSE-AC4: Voice transcript path

**Trigger:** Dominik reports macros or supplement intake by voice (transcribed by faster-whisper pipeline).

**Flow:**
1. Hibiki parses the transcript text for nutrition values or supplement names.
2. If **all macros present and unambiguous**: present for confirmation (same confirm-loop as PARSE-AC2 step 2-5).
3. If **partial or ambiguous** ("ettem valami kb 400 kalóriást"): ask for missing fields FIRST, then confirm-loop. Do NOT write a partial entry.
4. For **supplements by voice**: resolve supplement names against `hibiki-supplements.json`. If ambiguous nickname (e.g., "a berberine cucc"): ask for clarification before writing.

**Voice-specific edge cases:**
- Transcript mentions a supplement by nickname: resolve by best match from `hibiki-supplements.json`, confirm with Dominik if ambiguous.
- Transcript is entirely uninterpretable as health data: ask Dominik to clarify, do not write.

---

## PARSE-AC5: Manual text path (no confirm-loop required)

**Trigger:** Dominik states values directly in text: "1900 kcal, 180g fehérje, 185g szénhidrát, 58g zsír"

**Flow:**
1. Hibiki parses the values from text.
2. SEC-AC1 range validation.
3. `hibiki-health-write.py nutrition --date YYYY-MM-DD ... --source manual`

No confirmation presentation step -- Dominik's text is itself the confirmation.

---

## not-logged sentinel (NUT-AC1)

When Dominik confirms a day was not logged: `hibiki-health-write.py not-logged --date YYYY-MM-DD`

This writes `{"date": "YYYY-MM-DD", "logged": false}` -- distinct from a missing entry:
- Missing entry = unknown (excluded from both numerator and denominator in macro_avg)
- `logged: false` = confirmed no-log day (counted as gap in denominator when reporting coverage)

---

## Source field rules (SEC-AC3)

| Source | When to use |
|--------|-------------|
| `manual` | Dominik stated values directly in text; no inference step |
| `vision-confirmed` | Hibiki read via vision/PDF inference OR voice transcript, AND Dominik explicitly confirmed |

There are no other source values. The confirm-loop (SEC-AC2) is what earns the `vision-confirmed` label. DEXA entries are NOT exempt from source tagging.

---

## Coaching framing rules (COACH-AC1/2)

**Acceptable framing:**
- "Az utóbbi 7 naplózott napból a fehérje átlag 142g, ami 38g-mal a 180g cél alatt van. (5 manuális + 2 vision-confirmed nap alapján)"

**Not acceptable:**
- "Azonnal növeld a fehérje bevitelt."
- "A DEXA alapján változtass a supplementednen."

Hibiki flags trends and offers to discuss -- does not issue directives.

When reporting a trend built on `vision-confirmed` data: always include the source split ("X manuális + Y vision-confirmed nap alapján").
