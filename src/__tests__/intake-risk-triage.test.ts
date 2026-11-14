// Card c81ce4bf -- intake risk-triage. Covers the pure core, verdict
// monotonicity (chad c-MEDIUM), the NEEDS-INFO churn-guard tuned on the real
// corpus (marveen pt 1), back-compat, the DB wiring, and the no-auto-build
// caller note (chad c-LOW).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initNoaDb, getNoaDb } from '../noa-memory.js'
import { subscribeDashboardEvents, type DashboardEvent } from '../event-bus.js'
import {
  createCard,
  getCard,
  patchTriage,
  applyKanbanMigrations,
  TriageWeakenError,
} from '../noa-kanban.js'
import {
  classifyCardIntake,
  predictTags,
  contentFingerprint,
  normaliseForFingerprint,
  trackForLevel,
  verdictRank,
  isWeakeningVerdict,
  countDeliverables,
  DESC_LENGTH_FLOOR,
  INTAKE_VERDICTS,
  intakeDistributionSql,
  predictedHighCountSql,
  type OpenCardRef,
} from '../web/intake-triage.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(join(__dirname, '..', '..', 'scripts', 'schema-noa.sql'), 'utf8')

// A long, well-formed description (>= the real fleet corpus minimum of 193
// chars) -- the profile the churn-guard must NEVER flag as NEEDS-INFO.
const WELL_FORMED_DESC =
  'This card implements the token rotation sweep for the auth subsystem. Scope: add a scheduled job ' +
  'that re-provisions per-agent credentials, updates the secret store, and emits an audit event. ' +
  'Acceptance: existing sessions keep working; new tokens validate; rollback is a single revert.'

// A long, well-formed description with NO risk keywords -> predicted low.
const LOW_DESC =
  'This card adjusts the spacing and visual hierarchy of the dashboard board columns. Scope: tweak ' +
  'the CSS margins, padding, and font sizes for readability. Acceptance: the layout looks balanced ' +
  'on both wide and narrow viewports, with no visual overlap between adjacent cards.'

describe('predictTags -- prose keyword signals', () => {
  it('tags credential on secret/credential/.env/oauth language', () => {
    expect(predictTags('Rotate the OAuth credential store', 'update .env secrets')).toContain('credential')
  })
  it('tags security on auth/permission/gate language', () => {
    expect(predictTags('Fix the auth gate-check permission bug', null)).toContain('security')
  })
  it('tags destructive on drop-table / rm -rf / force-push language', () => {
    expect(predictTags('Migration that will DROP TABLE old_events', null)).toContain('destructive')
    expect(predictTags('cleanup script using rm -rf on temp dirs', null)).toContain('destructive')
  })
  it('tags exec on subprocess/eval/child_process language', () => {
    expect(predictTags('spawn a subprocess to run the build', null)).toContain('exec')
  })
  it('tags input-parsing on deserialize/webhook/upload language', () => {
    expect(predictTags('handle the incoming webhook and deserialize payload', null)).toContain('input-parsing')
  })
  it('does NOT over-tag an ordinary card', () => {
    expect(predictTags('Improve the dashboard card layout spacing', 'tweak CSS margins')).toEqual([])
  })
  it('bare "token" alone (no secret/auth/store context) is not credential', () => {
    // "token" is a very common word in this fleet; it only tags credential with
    // auth/secret/store/rotat/registry/jwt context.
    expect(predictTags('count the token usage per turn', 'telemetry only')).not.toContain('credential')
  })
})

describe('trackForLevel + level mapping (single-source level via gate-check)', () => {
  it('maps level to the Lean/Standard/Rigorous FSM track', () => {
    expect(trackForLevel('low')).toBe('lean')
    expect(trackForLevel('medium')).toBe('standard')
    expect(trackForLevel('high')).toBe('rigorous')
  })
  it('a credential/security/destructive prediction yields high -> rigorous', () => {
    const r = classifyCardIntake({ title: 'rotate credential secrets', description: WELL_FORMED_DESC })
    expect(r.level).toBe('high')
    expect(r.track).toBe('rigorous')
  })
})

describe('content fingerprint -- hash gate, NOT keyword overlap', () => {
  it('is whitespace- and case-insensitive on identical content', () => {
    const a = contentFingerprint('Fix Bug', 'Do   the\n thing')
    const b = contentFingerprint('fix   bug', 'do the thing')
    expect(a).toBe(b)
  })
  it('normalise collapses whitespace and lowercases', () => {
    expect(normaliseForFingerprint('A  B', ' C ')).toBe('a b c')
  })
  it('different content -> different fingerprint (even with high keyword overlap)', () => {
    // Same keywords, different content/state -> NOT a duplicate (the dedup lesson:
    // keyword/Jaccard overlap is a systematic false-positive, only a content hash
    // may trigger a reject).
    const a = contentFingerprint('Add auth token rotation', 'Phase 1: design the rotation sweep')
    const b = contentFingerprint('Add auth token rotation', 'Phase 2: implement the rotation sweep')
    expect(a).not.toBe(b)
  })
})

describe('classifyCardIntake -- deterministic verdicts', () => {
  it('ACCEPT for a well-formed card with no duplicate', () => {
    const r = classifyCardIntake({ title: 'Improve layout', description: WELL_FORMED_DESC })
    expect(r.verdict).toBe('accept')
  })

  it('REJECT content-duplicate via fingerprint (not keyword overlap)', () => {
    const title = 'Add auth token rotation'
    const desc = WELL_FORMED_DESC
    const open: OpenCardRef[] = [{ id: 'dup00001', fingerprint: contentFingerprint(title, desc) }]
    const r = classifyCardIntake({ title, description: desc }, open)
    expect(r.verdict).toBe('reject')
    expect(r.reasons[0]).toContain('content-duplicate of dup00001')
  })

  it('does NOT reject a keyword-overlapping but content-different card', () => {
    const open: OpenCardRef[] = [
      { id: 'other001', fingerprint: contentFingerprint('Add auth token rotation', 'Phase 1 design') },
    ]
    const r = classifyCardIntake({ title: 'Add auth token rotation', description: 'Phase 2 implement, ' + WELL_FORMED_DESC }, open)
    expect(r.verdict).not.toBe('reject')
  })

  it('NEEDS-INFO (not REJECT) for no-deliverable: empty description + thin title', () => {
    // A thin card is under-specified, not non-viable -- it routes to NEEDS-INFO
    // (salvageable via clarification), NOT an auto-parking REJECT.
    const r = classifyCardIntake({ title: 'x', description: '' })
    expect(r.verdict).toBe('needs-info')
    expect(r.reasons[0]).toContain('no deliverable')
  })

  it('NEEDS-INFO: thin description AND risky-looking', () => {
    const r = classifyCardIntake({ title: 'rm -rf cleanup', description: 'do it' })
    expect(r.level).toBe('high')
    expect(r.verdict).toBe('needs-info')
  })

  it('thin LOW-risk card is ACCEPT, not NEEDS-INFO (no bureaucracy on trivial work)', () => {
    const r = classifyCardIntake({ title: 'rename a label', description: 'tweak text' })
    expect(r.level).toBe('low')
    expect(r.verdict).toBe('accept')
  })

  it('RESCOPE: many enumerated deliverables', () => {
    const desc = WELL_FORMED_DESC + '\n- item one\n- item two\n- item three\n- item four\n- item five'
    const r = classifyCardIntake({ title: 'big multi-part task', description: desc })
    expect(r.verdict).toBe('rescope')
  })

  it('is deterministic -- same input twice, same result', () => {
    const input = { title: 'rotate credential secrets', description: WELL_FORMED_DESC }
    expect(classifyCardIntake(input)).toEqual(classifyCardIntake(input))
  })

  it('countDeliverables counts bullets and numbered items only', () => {
    expect(countDeliverables('- a\n* b\n1. c\n2) d\nplain line')).toBe(4)
  })
})

describe('NEEDS-INFO churn-guard -- tuned on the real corpus (marveen pt 1)', () => {
  it('floor is below the real fleet minimum description length (193) with margin', () => {
    // Real corpus (129 open cards, 2026-11-14): min desc = 193, zero below 80.
    expect(DESC_LENGTH_FLOOR).toBeLessThan(193)
    expect(DESC_LENGTH_FLOOR).toBeLessThanOrEqual(80)
  })

  it('a well-formed high-risk fleet card is NEVER false-flagged NEEDS-INFO', () => {
    // High-risk KEYWORDS present, but a proper description -> ACCEPT, not NEEDS-INFO.
    const r = classifyCardIntake({ title: 'rotate credential secrets, drop table old', description: WELL_FORMED_DESC })
    expect(r.level).toBe('high')
    expect(r.verdict).toBe('accept')
    expect(WELL_FORMED_DESC.length).toBeGreaterThan(DESC_LENGTH_FLOOR)
  })
})

describe('verdict monotonicity (chad obligation c-MEDIUM)', () => {
  it('rank increases accept < rescope < needs-info < reject', () => {
    expect(INTAKE_VERDICTS).toEqual(['accept', 'rescope', 'needs-info', 'reject'])
    expect(verdictRank('accept')).toBeLessThan(verdictRank('rescope'))
    expect(verdictRank('rescope')).toBeLessThan(verdictRank('needs-info'))
    expect(verdictRank('needs-info')).toBeLessThan(verdictRank('reject'))
  })
  it('isWeakeningVerdict is true only for a strictly-looser transition', () => {
    expect(isWeakeningVerdict('needs-info', 'accept')).toBe(true)
    expect(isWeakeningVerdict('reject', 'needs-info')).toBe(true)
    expect(isWeakeningVerdict('accept', 'reject')).toBe(false)
    expect(isWeakeningVerdict('needs-info', 'needs-info')).toBe(false) // equal is allowed
  })
})

describe('§10 reconciliation / observability metric (marveen pt 2)', () => {
  it('exposes the intake distribution and predicted-high queries', () => {
    expect(intakeDistributionSql()).toMatch(/triage_verdict/)
    expect(intakeDistributionSql()).toMatch(/GROUP BY/i)
    expect(predictedHighCountSql()).toMatch(/triage_level = 'high'/)
  })
})

describe('no-auto-build caller note (chad obligation c-LOW)', () => {
  it('the triage route documents that the advisory consumer has no build-dispatch tool', () => {
    const routeSrc = readFileSync(join(__dirname, '..', 'web', 'routes', 'kanban.ts'), 'utf8')
    expect(routeSrc).toMatch(/NO-AUTO-BUILD|no build-dispatch|never dispatches a build/i)
  })
})

// --- DB-level wiring --------------------------------------------------------
describe('createCard / patchTriage wiring', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    initNoaDb(':memory:')
    getNoaDb().exec(SCHEMA_SQL)
    applyKanbanMigrations()
  })
  beforeEach(() => {
    getNoaDb().exec('DELETE FROM kanban_cards')
  })

  it('writes triage_* columns on a normal create (ACCEPT)', () => {
    const c = createCard({ title: 'Improve layout spacing', description: LOW_DESC, project: 'DASH' })
    const row = getCard(c.id)!
    expect(row.triage_verdict).toBe('accept')
    expect(row.triage_level).toBe('low')
    expect(row.triage_track).toBe('lean')
    expect(row.triaged_by).toBe('intake-core')
    expect(JSON.parse(row.triage_tags!)).toEqual([])
  })

  it('REJECT (content-duplicate) auto-parks to icebox and fires a distinct triage_rejected event', () => {
    // REJECT is reserved for a content-duplicate of an existing OPEN card.
    createCard({ title: 'Add auth token rotation', description: WELL_FORMED_DESC, project: 'OAUTH' })
    const events: DashboardEvent[] = []
    const unsub = subscribeDashboardEvents((e) => events.push(e))
    try {
      const c = createCard({ title: 'Add auth token rotation', description: WELL_FORMED_DESC, project: 'OAUTH' })
      const row = getCard(c.id)!
      expect(row.triage_verdict).toBe('reject')
      expect(row.status).toBe('icebox') // non-blocking auto-park
      const rej = events.find((e) => e.action === 'triage_rejected')
      expect(rej).toBeTruthy()
      expect(rej!.triage?.verdict).toBe('reject')
    } finally {
      unsub()
    }
  })

  it('back-compat: a thin card is NEEDS-INFO (not parked) and still fires the intake event', () => {
    // The existing intake-clarification contract (AC-7) is preserved: a thin card
    // stays planned and emits 'intake', now enriched with the triage verdict.
    const events: DashboardEvent[] = []
    const unsub = subscribeDashboardEvents((e) => events.push(e))
    try {
      const c = createCard({ title: 'y', description: '', project: 'ENG' })
      const row = getCard(c.id)!
      expect(row.triage_verdict).toBe('needs-info')
      expect(row.status).toBe('planned') // NOT parked
      const intake = events.find((e) => e.action === 'intake')
      expect(intake).toBeTruthy()
      expect(intake!.triage?.verdict).toBe('needs-info')
    } finally {
      unsub()
    }
  })

  it('back-compat: suppressIntake skips triage entirely (all triage_* NULL)', () => {
    const c = createCard({ title: 'z', description: '', project: 'ENG', suppressIntake: true })
    const row = getCard(c.id)!
    expect(row.triage_verdict).toBeNull()
    expect(row.triaged_at).toBeNull()
    expect(row.status).toBe('planned') // NOT auto-parked -- triage did not run
  })

  it('createCard dedups against existing OPEN cards by content fingerprint', () => {
    createCard({ title: 'Add auth token rotation', description: WELL_FORMED_DESC, project: 'OAUTH' })
    const dup = createCard({ title: 'Add auth token rotation', description: WELL_FORMED_DESC, project: 'OAUTH' })
    expect(getCard(dup.id)!.triage_verdict).toBe('reject')
  })

  it('patchTriage escalates (stricter) and persists', () => {
    const c = createCard({ title: 'Improve layout spacing', description: WELL_FORMED_DESC, project: 'DASH' })
    expect(getCard(c.id)!.triage_verdict).toBe('accept')
    expect(patchTriage(c.id, { verdict: 'needs-info', reasons: ['llm: scope unclear'], by: 'marveen' })).toBe(true)
    const row = getCard(c.id)!
    expect(row.triage_verdict).toBe('needs-info')
    expect(row.triaged_by).toBe('marveen')
  })

  it('patchTriage REFUSES a weakening verdict with TriageWeakenError (c-MEDIUM, code-enforced)', () => {
    const c = createCard({ title: 'rm -rf cleanup', description: 'do it', project: 'ENG' })
    expect(getCard(c.id)!.triage_verdict).toBe('needs-info')
    expect(() => patchTriage(c.id, { verdict: 'accept', by: 'marveen' })).toThrow(TriageWeakenError)
    // unchanged after the refused weakening
    expect(getCard(c.id)!.triage_verdict).toBe('needs-info')
  })

  it('patchTriage on a fresh (suppressed, NULL-verdict) card accepts any verdict', () => {
    const c = createCard({ title: 'z', description: 'x', project: 'ENG', suppressIntake: true })
    expect(getCard(c.id)!.triage_verdict).toBeNull()
    expect(patchTriage(c.id, { verdict: 'accept', by: 'marveen' })).toBe(true)
    expect(getCard(c.id)!.triage_verdict).toBe('accept')
  })

  it('patchTriage returns false for an unknown card', () => {
    expect(patchTriage('nope0000', { verdict: 'reject', by: 'marveen' })).toBe(false)
  })
})
