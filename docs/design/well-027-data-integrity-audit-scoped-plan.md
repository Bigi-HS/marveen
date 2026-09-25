# WELL-027 -- Data-Integrity Audit: Scoped Plan

Card: 351c80a7 (WELL-027, urgent, assignee dave). Boss URGENT 2026-08-25.
Reviewers already assigned (Boss 6346): blackbart = PM / acceptance-gap, devil-advocate =
adversarial corruption-path pre-mortem, thor = QA / test-coverage (+ gauge, chad on the test team).
marveen levels the findings into fix-cards.

Seed defect (the class we are hunting): Zepp 75337cdc mixed-granularity transform bug -- daily and
sparse-intraday windows blindly summed, producer shape ASSUMED not MEASURED, no plausibility gate on
the consumer side. This plan generalizes that class across every ingest path and every Boss-facing number.

## 0. Guiding principle -- label discipline (the through-line)

Every Boss-facing number must carry, in the audit ledger, one of three provenance labels:

- **[MEASURED]** -- a value that arrived as-is from an authoritative source (e.g. phone-reported steps).
- **[COMPUTED]** -- derived by our code (sum / max / ratio / rollup). Must name the aggregation and inputs.
- **[RELAYED]** -- passed through from another system without our own verification (e.g. an n8n
  transform result, a token-log line, a third-party API field).

A number with no label, or a [COMPUTED]/[RELAYED] number with no acceptance criterion tying it back to
input correctness, is a finding by definition (ref: detection-layer-without-enforcement-ac-is-silent-observer,
two-synthetic-greens). The audit output is a labeled ledger, not prose reassurance.

## 1. Scope -- concrete surface (grounded inventory)

### A. Ingest paths (external data -> storage)
| # | Path | File:line | Sink | Guards present | Prime suspects |
|---|------|-----------|------|----------------|----------------|
| A1 | POST /api/health/ingest | src/web/routes/health-ingest.ts:450 | store/zepp/daily-*.json | X-Ingest-Token, field no-clobber merge, 4 plausibility rules, date-guard, anomaly-record | merge edge cases; plausibility bounds vs real data; multi-push same-day |
| A2 | POST /api/health/ingest-raw | src/web/routes/health-ingest-raw.ts:21 | n8n -> A1 | none (public), n8n holds token | **HC_TRANSFORM_NODE_JS runs in UNVERIFIED n8n -- no signature that live == repo** |
| A3 | HC transform | src/web/zepp/hc-transform-node.ts:14-150 | canonical snapshot | own-day bucketing, slice-forward | mixed-granularity SUM (the seed bug); slice dedup by startAt only |
| A4 | Scheduled-task ingest (calendar/email surfaced into reports) | scheduled-tasks/*, MCP calendar/email | Telegram report | none on the numbers | event/time drift (0d95cc9b), unread-count truthfulness |
| A5 | Inter-agent messages | agent_messages (claudeclaw.db) | DB | none (routing primitives) | not a Boss-number source; scope only for injection (Chad owns) |

### B. DB layer (noa.db canonical vs claudeclaw.db legacy-frozen)
- noa.db (getNoaDb): kanban_cards, memories, memories_fts, analytics_snapshots, board_columns, kanban_comments.
- claudeclaw.db (src/db.ts, FROZEN ~Jun28): scheduled_tasks, conversation_log, agent_messages, token_usage,
  todo_items, guard_events, gate/ack/token registries, task_runs.
- **Split-brain risk:** any Boss-number that reads a table on the WRONG db reads frozen data. Audit must
  assert, per Boss-number, which db it reads and that the db is the live one (ref: split-brain memory).
- conversation_log migrated to noa.db (ENG-021); claudeclaw.db retire pending (morgan ENG-024) -- verify
  no Boss-number still reads the frozen ledger.

### C. Boss-facing number producers
| # | Number | File:line | Provenance target | Suspect |
|---|--------|-----------|-------------------|---------|
| C1 | Zepp health metrics (steps/kcal/distance/sleep/HR) | health-ingest + zepp store | [MEASURED] phone, [COMPUTED] activity SUM | mixed-granularity (seed); estimate ceilings |
| C2 | Zepp freshness (days stale) | health-zepp-freshness.ts | [COMPUTED] now - synced_at | synced_at source (measurement vs receipt time); n8n silent-fail |
| C3 | Zepp anomalies (open flags) | health-zepp-anomalies.ts | [COMPUTED] rule violations | auto-resolve without FP override; log-only vs gating |

## Bounds Recalibration (2026-09-25 gauge)

### Analysis: 33-day empirical corpus (08-05..09-06 + 09-21)

**Current plausibility bounds** (before recalibration):
- Rule 2 (stride m/step): [0.50, 0.90]
- Rule 1 (kcal/step): [0.03, 0.20]

**False-positive rate on current bounds**: 91.3% (21/23 gated days)

**Distribution on valid data** (steps >= 3000, n=23 for dist, n=18 for kcal):
- dist_per_step: median=0.491, p10=0.246, p25=0.355, p75=0.591, p90=0.651, max=0.975
- kcal_per_step: median=0.042, p10=0.019, p25=0.026, p75=0.085, p90=0.096, max=0.155

**Recalibrated bounds** (p10-p90 recommendation):
- Rule 2 (stride m/step): [0.25, 0.65] ← covers 80% of valid data
- Rule 1 (kcal/step): [0.02, 0.10] ← covers 80% of valid data

**False-positive rate on recalibrated bounds**: 26.1% (6/23 gated days)

**FP reduction**: 91.3% → 26.1% = **65% improvement**.

**Rationale**: Original bounds were calibrated on offline assumptions, not live data. The p10-p90 range captures the core 80% of observed activity while still catching true outliers (p10 and p90 edges guard against extreme anomalies). This reduces false flags by 65% while maintaining anomaly detection for genuinely unusual days.

**Next step**: Update health-ingest.ts rule implementation to use new bounds, deploy, and monitor FP-rate delta in production.
| C4 | Dashboard overview (agent/mem/task/turn counts) | overview.ts:66-95 | [COMPUTED] COUNT/filter | JSONL + DB dual-source double-count; start-of-day bucket TZ |
| C5 | Token cost USD (per-agent + lineage) | token-usage.ts:42-116 | [RELAYED] log parse + [COMPUTED] tokens*rate | cursor corruption -> double-count/skip; model-rate table staleness |
| C6 | Fable budget (5h/day/week) | token-usage.ts:85 | [COMPUTED] SUM window | window boundary TZ; project='fable' attribution completeness |
| C7 | Kanban CFD (planned/in_progress/waiting/done) | kanban-cfd.ts:37-91 | [COMPUTED] COUNT by status | archived/icebox exclusion correctness; snapshot cadence gaps |
| C8 | Morning report buckets | scheduled-tasks/reggeli-napindito | [RELAYED] DREAM.md + MCP | numbers relayed from a generated file; freshness of DREAM.md |

## 2. Workstreams and owners

- **WS1 -- Ingest correctness (dave, code).** Walk A1-A4 execution paths. For each: does a partial /
  delta / multi-push / mis-day / mixed-granularity body corrupt the stored value? Produce a failing test
  per real corruption path before any fix (TDD). Deliverable: per-path [MEASURED/COMPUTED] map + red tests.
- **WS2 -- Boss-number acceptance (blackbart, PM).** For each C1-C8: is there an acceptance criterion that
  ties the displayed number to INPUT correctness (not just "renders")? Gap = value-carrying AC to write.
  Deliverable: acceptance-gap list -> fix-cards.
- **WS3 -- Adversarial corruption pre-mortem (devil-advocate).** Assume each number is already wrong; find
  the cheapest input that makes it wrong while every current test stays green. Deliverable: ranked
  corruption paths with a concrete body/sequence each.
- **WS4 -- Test-coverage + plausibility (thor + gauge + chad).** Where are guards log-only vs gating?
  Where does a synthetic-green share the assumed-shape blindspot? chad owns injection surface (A5, memory
  filter, n8n proxy). Deliverable: coverage map + missing adversarial fixtures.
- **WS5 -- Provenance verification (dave).** The two structural gaps: (a) HC_TRANSFORM live-vs-repo drift
  (A2/A3 run in n8n with no signature) -- propose a deploy-time hash assert; (b) split-brain db reads --
  assert every Boss-number reads the live db. Deliverable: 2 hardening cards.

## 3. Prime hypotheses (rank first, disprove first -- debugging discipline)

1. **HC transform drift (A2/A3).** Live n8n node may not equal the repo string. HIGH: the transform is
   the seed-bug locus and is the one component with zero deploy-time verification. First check: diff the
   deployed n8n node JS against HC_TRANSFORM_NODE_JS byte-for-byte (n8n-ops read).
2. **Multi-push / partial-push clobber residue (A1).** Field no-clobber merge landed (WELL-018), but verify
   on REAL multi-instance same-day data (two naps, evening workout after morning sleep) that nothing
   regresses -- ref append-only-blob-still-clobbers-multi-instance.
3. **Token cost double-count (C5).** Cursor has no checksum; a re-parse or rotated log can double-count or
   skip. Verify cursor invariants against the actual session log.
4. **Freshness/anomaly silent-fail (C2/C3).** n8n freshness workflow error = silent monitor (ref
   n8n-shared-credential-decrypt cascade). Verify the monitor actually fires on a stale/empty state.
5. **Overview dual-source double-count (C4).** task_runs DB + JSONL both counted -- verify no overlap
   double-counts, and TZ of start-of-day is Budapest.

## 4. Acceptance / done-definition for WELL-027

- A labeled ledger for every C1-C8 number: [MEASURED/COMPUTED/RELAYED] + input->number chain + one named
  blindspot each.
- Every corruption path found by WS1/WS3 is either (a) covered by a red-then-green test, or (b) filed as a
  ranked fix-card with a repro body. No corruption path left as prose.
- The two provenance gaps (HC drift, split-brain) each have a hardening card.
- marveen levels findings into fix-cards; WELL-027 stays open until each leveled card is either done or
  explicitly deferred with a reason.

## 5. Non-goals

- Not a security/injection audit end-to-end (Chad owns A5 + memory filter + n8n proxy separately).
- Not the retire of claudeclaw.db (morgan ENG-024) -- only assert no Boss-number reads it.
- Not new features -- correctness only.
