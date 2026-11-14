// ---------------------------------------------------------------------------
// Card-intake risk-triage (card c81ce4bf)
//
// The CARD-TIME predecessor of the CHECK-TIME gate risk classifier (card
// 66cf63ed, src/web/gate-check.ts). Given a card's TEXT (title + description)
// it emits an ADVISORY verdict (accept | rescope | needs-info | reject), a
// predicted risk LEVEL, a process TRACK, and predicted surface TAGS.
//
// THREE load-bearing boundaries (marveen + chad design review):
//  1. ONE risk vocabulary. `RiskLevel` / `Tag` / `levelForTags` are IMPORTED
//     from gate-check.ts -- there is NO parallel second risk concept. The
//     predicted level is a text-based ESTIMATE of the same quantity the gate
//     later derives authoritatively from the diff.
//  2. ONE enforcement source. Everything here is ADVISORY. The gate re-derives
//     the reviewer seat-set from the live diff on every runGateCheck; the triage
//     verdict/tags are NEVER an input to that (mirrors the gate_pr_risk advisory
//     store). This module performs NO IO and is imported ONE-WAY (intake-triage
//     -> gate-check, never the reverse) so gate enforcement can never read it.
//  3. NEVER blocks card creation. A REJECT does not refuse the insert; the
//     caller records the verdict, auto-parks the card, and notifies. See
//     store/specs/v2-intake-risk-triage.md.
//
// Pure: no clock, no network, no randomness, no LLM. Same card -> same verdict.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { Tag, RiskLevel, levelForTags } from './gate-check.js'

export const INTAKE_VERDICTS = ['accept', 'rescope', 'needs-info', 'reject'] as const
export type IntakeVerdict = (typeof INTAKE_VERDICTS)[number]

export const INTAKE_TRACKS = ['lean', 'standard', 'rigorous'] as const
export type IntakeTrack = (typeof INTAKE_TRACKS)[number]

export interface IntakeResult {
  verdict: IntakeVerdict
  level: RiskLevel
  track: IntakeTrack
  tags: Tag[] // predicted, advisory, sorted + de-duplicated
  reasons: string[] // which rule fired, for audit
}

export interface IntakeCardInput {
  title: string
  description?: string | null
}

// A reference to an existing OPEN card, used only for content-duplicate
// detection. `fingerprint` is contentFingerprint(title, description).
export interface OpenCardRef {
  id: string
  fingerprint: string
}

// --- Content fingerprint (duplicate gate) -----------------------------------
// Whitespace-normalised + case-folded SHA-256 of title+description. This is a
// CONTENT-hash gate, NOT keyword/Jaccard overlap: two cards are duplicates only
// when their normalised text is byte-identical. Honours
// lesson-dedup-feature-overlap-needs-content-hash-gate-1113 (keyword overlap is
// a systematic false-positive source; only a content hash may trigger a reject).
export function normaliseForFingerprint(title: string, description?: string | null): string {
  return `${title}\n${description ?? ''}`.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function contentFingerprint(title: string, description?: string | null): string {
  return createHash('sha256').update(normaliseForFingerprint(title, description)).digest('hex')
}

// --- Text -> predicted tags -------------------------------------------------
// Prose signals (NOT regex-on-diff like the gate -- this is a card description,
// not code). Deliberately over-inclusive for RISK prediction: a wrong "high"
// costs one advisory ceremony step; a missed "high" is the class we avoid. Over-
// inclusiveness is safe here because NEEDS-INFO is additionally gated by the
// length-floor (so the fleet's own well-formed cards cannot be bureaucratised --
// see classifyCardIntake) and the verdict never binds the gate.
//
// TUNABLE: this keyword set and the thresholds below are tuned with the §10
// reconciliation metric (predicted-high vs gate-confirmed-chad), not guessed.
const CREDENTIAL_RE = /\b(credential|secret|oauth|api[- ]?keys?|\.env)\b/i
const CREDENTIAL_TOKEN_RE = /\btokens?\b/i
const CREDENTIAL_TOKEN_CTX_RE = /\b(auth|secret|store|rotat|registry|jwt)\b/i
const SECURITY_RE = /\b(auth|authn|authz|permission|guardrail|gate-?check|rbac|login|session)\b/i
const DESTRUCTIVE_RE = /\b(rm\s+-rf|drop\s+table|truncate|destroy|wipe|purge|force[- ]?push|reset\s+--hard|delete\s+(all|data|table|row))\b/i
const EXEC_RE = /\b(exec|spawn|subprocess|child[_ ]?process|os\.system|shell\s+command|arbitrary\s+code)\b/i
const PARSE_RE = /\b(deserial\w*|pickle|yaml\.load|webhook|file\s+upload|untrusted\s+input|xxe|external\s+entit)\b/i

export function predictTags(title: string, description?: string | null): Tag[] {
  const text = `${title}\n${description ?? ''}`
  const tags = new Set<Tag>()
  if (CREDENTIAL_RE.test(text) || (CREDENTIAL_TOKEN_RE.test(text) && CREDENTIAL_TOKEN_CTX_RE.test(text))) {
    tags.add('credential')
  }
  if (SECURITY_RE.test(text)) tags.add('security')
  if (DESTRUCTIVE_RE.test(text)) tags.add('destructive')
  if (EXEC_RE.test(text)) tags.add('exec')
  if (PARSE_RE.test(text)) tags.add('input-parsing')
  return [...tags].sort()
}

// --- Track mapping (Lean/Standard/Rigorous FSM, bound to OUR level) ----------
// The ZazenCodes software-factory-v2 bin/route FSM, mapped onto the 66cf63ed
// RiskLevel -- NOT a second risk axis. The track is an ADVISORY process hint
// (does this need spec-first / design-review?), it does NOT set reviewer seats
// (the gate does) and does NOT block anything.
export function trackForLevel(level: RiskLevel): IntakeTrack {
  if (level === 'high') return 'rigorous'
  if (level === 'medium') return 'standard'
  return 'lean'
}

// --- Verdict partial order (monotonicity) -----------------------------------
// accept < rescope < needs-info < reject (increasing scrutiny). The advisory
// LLM enrichment layer may only make a verdict STRICTER, never looser (chad
// obligation c-MEDIUM): the PATCH handler enforces this with isWeakeningVerdict
// and 400s on a weakening transition -- CODE, not prompt discipline.
export function verdictRank(v: IntakeVerdict): number {
  return INTAKE_VERDICTS.indexOf(v)
}

export function isWeakeningVerdict(current: IntakeVerdict, next: IntakeVerdict): boolean {
  return verdictRank(next) < verdictRank(current)
}

// --- Deterministic core -----------------------------------------------------
// NEEDS-INFO length-floor. TUNED on the real fleet corpus (129 open cards,
// 2026-11-14): the SHORTEST real description was 193 chars and ZERO cards fell
// below 80. A floor of 80 therefore has >2x headroom -- the fleet's own well-
// formed cards (incl. kanban-bulk-create.py output) never trip a false
// NEEDS-INFO (marveen review pt 1), while a genuinely thin one-line card still
// does. Regression-tested against the sampled corpus profile.
export const DESC_LENGTH_FLOOR = 80

// RESCOPE hint threshold: this many distinct enumerated deliverables suggests
// the card should be split. Advisory only (non-blocking).
export const MULTI_DELIVERABLE_THRESHOLD = 4

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length
}

// Count enumerated deliverables: markdown bullets (-, *, +) and numbered items
// at line starts. Conservative -- only a strong split signal.
export function countDeliverables(description: string): number {
  let n = 0
  for (const raw of description.split('\n')) {
    if (/^\s*([-*+]|\d+[.)])\s+\S/.test(raw)) n++
  }
  return n
}

export function classifyCardIntake(card: IntakeCardInput, openCards: OpenCardRef[] = []): IntakeResult {
  const title = (card.title ?? '').trim()
  const desc = (card.description ?? '').trim()
  const tags = predictTags(title, card.description)
  const level = levelForTags(tags)
  const track = trackForLevel(level)

  // REJECT: content-duplicate of an existing open card (content-hash gate, not
  // keyword overlap). Highest-confidence deterministic reject.
  const fp = contentFingerprint(title, card.description)
  const dup = openCards.find((c) => c.fingerprint === fp)
  if (dup) {
    return { verdict: 'reject', level, track, tags, reasons: [`content-duplicate of ${dup.id}`] }
  }

  // NEEDS-INFO: no deliverable -- empty description AND a thin (sub-2-word)
  // title. This is the UNDER-SPECIFIED case, not a non-viable one: it is
  // salvageable by clarification, so it routes to NEEDS-INFO (which does NOT
  // auto-park) and keeps firing the existing intake-clarification event. REJECT
  // is reserved for the high-confidence content-duplicate above.
  if (desc.length === 0 && wordCount(title) < 2) {
    return { verdict: 'needs-info', level, track, tags, reasons: ['needs-info: no deliverable (empty description and thin title)'] }
  }

  // NEEDS-INFO: under-specified AND risky-looking. Gated by the tuned floor so
  // low-risk thin cards are ACCEPT (we do not bureaucratise trivial work) and
  // real fleet cards never trip it.
  if (desc.length < DESC_LENGTH_FLOOR && (level === 'medium' || level === 'high')) {
    return {
      verdict: 'needs-info',
      level,
      track,
      tags,
      reasons: [`needs-info: description ${desc.length} < floor ${DESC_LENGTH_FLOOR} on ${level}-risk card`],
    }
  }

  // RESCOPE: accepted, but multiple distinct deliverables -> split hint.
  const deliverables = countDeliverables(desc)
  if (deliverables >= MULTI_DELIVERABLE_THRESHOLD) {
    return {
      verdict: 'rescope',
      level,
      track,
      tags,
      reasons: [`rescope-hint: ${deliverables} distinct deliverables detected`],
    }
  }

  return { verdict: 'accept', level, track, tags, reasons: ['accept'] }
}

// --- §10 reconciliation / observability metric ------------------------------
// The intake-side measurement that feeds the predictor's data-tuning loop
// (marveen review pt 2). Counts the triage verdict/level distribution over a
// window from the triage_* columns written at intake.
//
// NOTE on the cross-side join: fully correlating "predicted high at intake" with
// "gate-confirmed chad-required" needs a card<->PR linkage that does not yet
// exist as a stored FK (PRs reference cards only in their title text). The
// measurable intake-side signal ships here; the gate-side correlation lands with
// the cost-board card (e230c097), which introduces the per-job PR<->card link.
export function intakeDistributionSql(): string {
  return `
    SELECT triage_verdict AS verdict, triage_level AS level, COUNT(*) AS n
    FROM kanban_cards
    WHERE triage_verdict IS NOT NULL AND triaged_at >= ?
    GROUP BY triage_verdict, triage_level
    ORDER BY n DESC`
}

// Count of cards the intake predicted as high-risk in a window -- the numerator
// the cost-board will reconcile against gate-confirmed chad seats.
export function predictedHighCountSql(): string {
  return `
    SELECT COUNT(*) AS n FROM kanban_cards
    WHERE triage_level = 'high' AND triaged_at >= ?`
}
