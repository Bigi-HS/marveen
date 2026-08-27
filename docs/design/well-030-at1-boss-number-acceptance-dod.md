# WELL-030 DoD — AT-1 Boss-number acceptance (normative input→output)

**Owner:** Black Bart (PM, normative source). **Consumer:** Dave (AT-1 TDD executor).
**Card:** 44783957 P0 / AT-1. **Standing Zepp GO** applies.

Purpose: pin the REAL input→Boss-facing number chain with value-carrying assertions, not
synthetic shape. Every number below is MEASURED from the deployed code + the real landed
record, not relayed.

---

## 0. Correction to the relayed target triple (measure, don't assume)

The plan (`card-44783957-test-hardening-synthesis.md:13`) cites `distanceM=12040 /
activeKcal=1011 / steps=13694` as the célszám. **None of that triple is a real landed
record.** Verified against all `store/zepp/daily-2026-08-*.json`:

- `steps=13694` — no day has it (closest: 08-12 = 13506).
- `activeKcal=1011` — no day has it.
- `distanceM=12040` — appears only as a CODE COMMENT (`distance-estimate.ts:18`), the
  Boss "known-good calibration day" reference (12040 m @ 15790 steps → 0.7625 m/step). It
  is not an input and not the deployed output (see §3).

The real BUG-2 day — the whole reason AT-1 exists — is **2026-08-25**:
`steps=15790, distanceM=456 (measured, broken), activeKcal=5 (measured, broken)`.
AT-1 is grounded on 08-25, the actual incident record.

---

## 1. INPUT (raw HC fields, real 2026-08-25)

| field | value | note |
|---|---|---|
| `steps` | `15790` | survives upstream; this drives the estimate |
| `activity.distanceM` | `456` | MEASURED, implausibly short (BUG-2 upstream distance loss) |
| `activity.activeKcal` | `5` | MEASURED, implausibly short (same upstream loss) |

Source record: `store/zepp/daily-2026-08-25.json` (landed, status=ok).

---

## 2. EXPECTED OUTPUT — distance (the Boss-facing number)

The remediation is `applyDistanceEstimate()` + `distanceForDisplay()`
(`src/web/zepp/distance-estimate.ts`). For the 08-25 input:

| output field | expected value | why |
|---|---|---|
| `activity.distanceSource` | `'step_estimated'` | 15790 ≥ 1000 AND 456 < 15790×0.4=6316 → estimate fires |
| `activity.estimatedDistanceM` | **`12032`** | `round(15790 × 0.762)` — see §3, NOT 12040 |
| `activity.distanceM` | `456` | UNCHANGED — measured is never overwritten, estimate sits alongside |
| `distanceForDisplay()` | `{ meters: 12032, source: 'step_estimated' }` | the selector the consumer calls |
| Boss string | `"~12 km (becsult, lepesbol)"` | 12032 m → 12 km, estimate-labelled |

---

## 3. Stride: FIXED constant, not per-day calibrated

- `DEFAULT_STRIDE_M = 0.762` (a constant). Estimate = `round(steps × 0.762)`. Overridable
  via the `strideM` option, but **no per-day calibration is wired** — it is the same 0.762
  for every day.
- For Boss-day steps=15790 → `round(15790 × 0.762) = 12032`.
- **The 12040 in the plan is wrong for a value-carrying test.** 12040 = `round(15790 ×
  0.7625)` (the exact calibration RATIO). The DEPLOYED constant is the rounded 0.762, which
  yields **12032**. Assert 12032, or the test red-fails against correct code.
- If a future Boss-day has steps ≠ 15790, the expected estimate is `round(steps × 0.762)`
  for that day's steps — recompute, do not reuse 12032.

---

## 4. Tolerance

- **`estimatedDistanceM`: EXACT equality (`=== 12032`).** It is a deterministic pure
  function of steps × a fixed constant; a band would mask a stride-constant drift (exactly
  the class of silent regression AT-1 exists to catch). No ±X.
- **Boss display km: exact `"12 km"`** (12032 m rounded to nearest km). Coarser layer, still
  exact once you fix the rounding rule (nearest-km).
- The measured `distanceM` assertion is exact too: `=== 456`, proving no overwrite.

---

## 5. activeKcal — DETECTION only, NO output number (scope boundary)

There is **no kcal remediation/estimate** in the code — only a DETECTOR
(`health-plausibility.ts` Rule 1) that flags `activeKcal=5 @ 15790 steps` as implausible,
surfaced as a `'suspect'` health-guard alert. So:

- AT-1 **cannot** assert a kcal OUTPUT number. `activeKcal=1011` has no producing code path.
- What AT-1 CAN assert for kcal: the broken value (5) is **flagged suspect** (detection),
  and is **not silently shown as a real number** to the Boss. That is a detection assertion,
  not a corrected-value assertion.
- **DECIDED (marveen, 2026-08-26): WELL-030 = DETECTION-ONLY for kcal.** AT-1 asserts the
  distance value-carrying number (12032) + a kcal SUSPECT-FLAG emit (detection). No kcal
  output-number is asserted — none exists in code, so it would be a value-independent (empty)
  assertion. This keeps the test-hardening card shippable tonight. A kcal ESTIMATE (modelled
  on the WELL-028 step-distance remediation) is a SEPARATE scoped card marveen files for the
  Boss's morning review; if the Boss wants it in scope it folds in easily, but it is NOT part
  of WELL-030/AT-1.

---

## 6. How to run AT-1 (two layers)

1. **NOW (unblocks TDD):** deterministic pin through the pure functions —
   `applyDistanceEstimate(snap08_25)` then `distanceForDisplay(result.activity)` — asserting
   §2 exactly. This pins input→Boss-number with zero synthetic shape (real field values).
2. **Stronger (depends on P0.5 raw-buffer):** drive the same assertions through the ingest
   handler on a CAPTURED raw 08-25 HC push, so the test also covers the transform/merge path,
   not just the estimator. Blocked until raw-retention exists (only 1 goldsample today). Do
   not fake a raw push — that re-inherits the synthetic-shape blindspot AT-1 is meant to kill.

---

## 7. Scope boundary — AT-1 proves the ESTIMATOR, not Boss-visibility

AT-1 (this DoD) pins that the estimator PRODUCES 12032 from the real 08-25 input. It does
NOT prove the Boss ever SEES it. Measured 08-26 (git grep): `distanceForDisplay()` has zero
callers; `estimatedDistanceM` is read by nothing; the real Boss-facing consumer is an LLM
(Hibiki) via `scripts/_marveen-zepp-delegate-hibiki-dave.py:13`, which is told to read only
`activity(activeKcal, distanceM)` — it renders the broken raw `distanceM=456` and never sees
the estimate. So WELL-028/PR#540 delivers zero Boss value until the last-mile display wiring
lands. That last mile is a SEPARATE card: **WELL / 849dbab8** (computed-but-not-surfaced;
owner=dave, 5 value-carrying AC). AT-1 remaining green while the Boss still sees 456 is
exactly the absence-of-errors fallacy — do not read AT-1 pass as "the Boss sees ~12 km".

---

## DoD checklist (binary)

- [ ] Test asserts `estimatedDistanceM === 12032` for the real 08-25 input (NOT 12040).
- [ ] Test asserts `distanceSource === 'step_estimated'` and measured `distanceM === 456` (no overwrite).
- [ ] Test asserts `distanceForDisplay()` returns `{ meters: 12032, source: 'step_estimated' }`.
- [ ] Boss display asserts `"12 km"` + estimate label.
- [ ] kcal: asserts `activeKcal=5` is flagged suspect (detection), NOT corrected to a number.
- [ ] Runs through the merge-gate; no gate bypass.
