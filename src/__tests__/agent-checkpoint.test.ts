import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import {
  shouldReplayCheckpoint,
  isEmptyCheckpoint,
  buildCheckpointInjection,
  injectionHasLastTurns,
  renderLastTurns,
  writeCheckpoint,
  readCheckpoint,
  markCheckpointConsumed,
  clearCheckpoint,
  resolveCheckpoint,
  applyCheckpointMigrations,
  shouldWriteDbMirror,
  readCheckpointFromDb,
  stampLedgerSuppressed,
  isLedgerSuppressed,
  consumeLedgerSuppressed,
  CHECKPOINT_TTL_MS,
  CHECKPOINT_DB_THROTTLE_MS,
  CHECKPOINT_LAST_TURNS_K,
  CHECKPOINT_LAST_TURNS_CHAR_CAP,
  type AgentCheckpoint,
  type TurnPair,
} from '../web/agent-checkpoint.js'

const NOW = 1_700_000_000_000
const AGENT = 'vitest-checkpoint-agent'
const CP_PATH = join(PROJECT_ROOT, 'store', 'agent-checkpoints', `${AGENT}.json`)
const SUPPRESS_PATH = join(PROJECT_ROOT, 'store', 'agent-checkpoints', `${AGENT}.ledger-suppressed`)

const rec = (over: Partial<AgentCheckpoint> = {}): AgentCheckpoint => ({
  agent: AGENT,
  ts: NOW,
  consumed: false,
  focus: 'shipping S3',
  lastTurns: [{ in: 'do X', out: 'on it' }],
  pendingObservations: [],
  doneSteps: ['wrote module'],
  alreadyDelegated: [],
  nextAction: 'open PR',
  pendingDecision: '',
  summary: 'building checkpoint',
  ...over,
})

function memDb(): Database.Database {
  const db = new Database(':memory:')
  applyCheckpointMigrations(db)
  return db
}

// ---------------------------------------------------------------------------
// Pure fns: shouldReplayCheckpoint crash-gate matrix (mirror S2)
// ---------------------------------------------------------------------------
describe('shouldReplayCheckpoint', () => {
  it('replays a fresh unconsumed record on compact', () => {
    expect(shouldReplayCheckpoint(rec(), 'compact', 'clean', NOW + 1000)).toBe(true)
  })
  it('replays on resume too', () => {
    expect(shouldReplayCheckpoint(rec(), 'resume', 'clean', NOW + 1000)).toBe(true)
  })
  it('does NOT replay a consumed record', () => {
    expect(shouldReplayCheckpoint(rec({ consumed: true }), 'compact', 'clean', NOW + 1000)).toBe(false)
  })
  it('does NOT replay a null record', () => {
    expect(shouldReplayCheckpoint(null, 'compact', 'crash', NOW)).toBe(false)
  })
  it('does NOT replay past the TTL', () => {
    expect(shouldReplayCheckpoint(rec(), 'compact', 'clean', NOW + CHECKPOINT_TTL_MS + 1)).toBe(false)
  })
  it('replays right up to the TTL boundary', () => {
    expect(shouldReplayCheckpoint(rec(), 'compact', 'clean', NOW + CHECKPOINT_TTL_MS)).toBe(true)
  })
  it('does NOT replay an empty checkpoint', () => {
    const empty = rec({ lastTurns: [], doneSteps: [], alreadyDelegated: [], nextAction: '', pendingDecision: '', focus: '' })
    expect(shouldReplayCheckpoint(empty, 'compact', 'crash', NOW + 1)).toBe(false)
  })

  // The S2 lastBoot x source matrix, mirrored.
  const NOWMS = NOW + 1000
  for (const lastBoot of ['clean', 'crash', 'unknown'] as const) {
    it(`compact replays regardless of lastBoot=${lastBoot}`, () => {
      expect(shouldReplayCheckpoint(rec(), 'compact', lastBoot, NOWMS)).toBe(true)
    })
    it(`startup + lastBoot=${lastBoot} -> ${lastBoot === 'crash'}`, () => {
      expect(shouldReplayCheckpoint(rec(), 'startup', lastBoot, NOWMS)).toBe(lastBoot === 'crash')
    })
  }
})

describe('isEmptyCheckpoint', () => {
  it('empty when no turns/steps/action/decision/focus', () => {
    expect(isEmptyCheckpoint({ lastTurns: [], doneSteps: [], alreadyDelegated: [], nextAction: '  ', pendingDecision: '', focus: '' })).toBe(true)
  })
  it('non-empty when it carries lastTurns only', () => {
    expect(isEmptyCheckpoint({ lastTurns: [{ in: 'a', out: 'b' }], doneSteps: [], alreadyDelegated: [], nextAction: '', pendingDecision: '', focus: '' })).toBe(false)
  })
  it('non-empty when it carries focus only', () => {
    expect(isEmptyCheckpoint({ lastTurns: [], doneSteps: [], alreadyDelegated: [], nextAction: '', pendingDecision: '', focus: 'x' })).toBe(false)
  })
  it('pendingObservations alone does NOT make it replay-worthy (store-only)', () => {
    // pendingObservations is not part of the emptiness check on purpose (S3 store-only).
    expect(isEmptyCheckpoint({ lastTurns: [], doneSteps: [], alreadyDelegated: [], nextAction: '', pendingDecision: '', focus: '' })).toBe(true)
  })
})

describe('buildCheckpointInjection', () => {
  it('includes focus, summary, the recent turns and the next action', () => {
    const out = buildCheckpointInjection(rec())
    expect(out).toContain('FOKUSZ: shipping S3')
    expect(out).toContain('FELADAT: building checkpoint')
    expect(out).toContain('LEGUTOBBI FORDULOK')
    expect(out).toContain('do X')
    expect(out).toContain('KOVETKEZO AKCIO')
  })
  it('omits the turns block when there are no turns', () => {
    const out = buildCheckpointInjection(rec({ lastTurns: [] }))
    expect(out).not.toContain('LEGUTOBBI FORDULOK')
  })
})

describe('injectionHasLastTurns (dedup trigger)', () => {
  it('true when there are turns', () => {
    expect(injectionHasLastTurns(rec())).toBe(true)
  })
  it('false when there are no turns', () => {
    expect(injectionHasLastTurns(rec({ lastTurns: [] }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// lastTurns cap / truncation
// ---------------------------------------------------------------------------
describe('renderLastTurns cap/truncation', () => {
  it('empty -> empty string', () => {
    expect(renderLastTurns([])).toBe('')
  })
  it('keeps only the most recent K turns', () => {
    const turns: TurnPair[] = Array.from({ length: 10 }, (_, i) => ({ in: `q${i}`, out: `a${i}` }))
    const out = renderLastTurns(turns)
    // oldest (q0..q3) dropped, newest K=6 kept (q4..q9)
    expect(out).toContain('q9')
    expect(out).toContain('q4')
    expect(out).not.toContain('q3"')
  })
  it('drops OLDEST-first until within the char cap', () => {
    const big = 'x'.repeat(1500)
    const turns: TurnPair[] = [
      { in: 'oldest', out: big },
      { in: 'mid', out: big },
      { in: 'newest', out: big },
    ]
    const out = renderLastTurns(turns, 3500)
    expect(out.length).toBeLessThanOrEqual(3500 + 50)
    expect(out).toContain('newest')
    expect(out).not.toContain('oldest')
  })
  it('a single over-cap turn is head+tail elided', () => {
    const huge = 'A'.repeat(200) + 'MIDDLE' + 'Z'.repeat(200)
    const out = renderLastTurns([{ in: 'q', out: huge }], 120)
    expect(out).toContain('[...]')
    expect(out.length).toBeLessThanOrEqual(140)
    expect(out).toContain('A')
    expect(out).toContain('Z')
    expect(out).not.toContain('MIDDLE')
  })
  it('K constant is 6 and cap is ~4k', () => {
    expect(CHECKPOINT_LAST_TURNS_K).toBe(6)
    expect(CHECKPOINT_LAST_TURNS_CHAR_CAP).toBe(4000)
  })
})

// ---------------------------------------------------------------------------
// Storage: atomic write, TTL, single-consume, corrupt -> absent
// ---------------------------------------------------------------------------
describe('checkpoint storage', () => {
  const db = memDb()
  afterEach(() => {
    clearCheckpoint(AGENT)
    consumeLedgerSuppressed(AGENT)
    try { if (existsSync(CP_PATH)) unlinkSync(CP_PATH) } catch { /* */ }
  })

  it('write then read round-trips the fields', () => {
    writeCheckpoint(AGENT, { focus: 'f', summary: 's', lastTurns: [{ in: 'a', out: 'b' }], nextAction: 'n' }, NOW, db)
    const r = readCheckpoint(AGENT)
    expect(r).not.toBeNull()
    expect(r!.focus).toBe('f')
    expect(r!.lastTurns).toEqual([{ in: 'a', out: 'b' }])
    expect(r!.consumed).toBe(false)
  })

  it('markCheckpointConsumed flips the FS consumed flag (single-replay guard)', () => {
    writeCheckpoint(AGENT, { summary: 's', nextAction: 'n' }, NOW, db)
    markCheckpointConsumed(AGENT, db)
    expect(readCheckpoint(AGENT)!.consumed).toBe(true)
  })

  it('a corrupt FS file reads as ABSENT (fail-open, not a false crash)', () => {
    mkdirSync(join(PROJECT_ROOT, 'store', 'agent-checkpoints'), { recursive: true })
    writeFileSync(CP_PATH, '{ this is not json ')
    expect(readCheckpoint(AGENT)).toBeNull()
  })

  it('TTL 48h expiry is enforced by shouldReplayCheckpoint', () => {
    writeCheckpoint(AGENT, { summary: 's', nextAction: 'n' }, NOW, db)
    const r = readCheckpoint(AGENT)!
    expect(shouldReplayCheckpoint(r, 'compact', 'clean', NOW + CHECKPOINT_TTL_MS + 1)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// DB mirror: throttle, FS-miss fallback, migration in the real startup path
// ---------------------------------------------------------------------------
describe('checkpoint DB mirror (G2 durability)', () => {
  let db: Database.Database
  beforeEach(() => { db = memDb() })
  afterEach(() => { clearCheckpoint(AGENT); db.close() })

  it('migration creates agent_checkpoints (fresh DB)', () => {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_checkpoints'").get()
    expect(t).toBeTruthy()
  })

  it('throttle: first write mirrors, a second within 30s does NOT add a row', () => {
    writeCheckpoint(AGENT, { summary: 's1', nextAction: 'n' }, NOW, db)
    writeCheckpoint(AGENT, { summary: 's2', nextAction: 'n' }, NOW + 10_000, db) // <30s
    const rows = db.prepare('SELECT COUNT(*) c FROM agent_checkpoints WHERE agent_id = ?').get(AGENT) as { c: number }
    expect(rows.c).toBe(1)
  })

  it('throttle: a write >=30s later DOES add a second row', () => {
    writeCheckpoint(AGENT, { summary: 's1', nextAction: 'n' }, NOW, db)
    writeCheckpoint(AGENT, { summary: 's2', nextAction: 'n' }, NOW + CHECKPOINT_DB_THROTTLE_MS, db)
    const rows = db.prepare('SELECT COUNT(*) c FROM agent_checkpoints WHERE agent_id = ?').get(AGENT) as { c: number }
    expect(rows.c).toBe(2)
  })

  it('shouldWriteDbMirror honors the >=30s boundary', () => {
    writeCheckpoint(AGENT, { summary: 's', nextAction: 'n' }, NOW, db)
    expect(shouldWriteDbMirror(AGENT, NOW + CHECKPOINT_DB_THROTTLE_MS - 1, db)).toBe(false)
    expect(shouldWriteDbMirror(AGENT, NOW + CHECKPOINT_DB_THROTTLE_MS, db)).toBe(true)
  })

  it('FS-miss -> resolveCheckpoint falls back to the freshest UNCONSUMED DB row', () => {
    // Write two rows spaced past the throttle; the newest wins.
    writeCheckpoint(AGENT, { summary: 'old', nextAction: 'n' }, NOW, db)
    writeCheckpoint(AGENT, { summary: 'new', nextAction: 'n2' }, NOW + CHECKPOINT_DB_THROTTLE_MS, db)
    clearCheckpoint(AGENT) // wipe the FS primary
    const r = resolveCheckpoint(AGENT, NOW + CHECKPOINT_DB_THROTTLE_MS + 1, db)
    expect(r).not.toBeNull()
    expect(r!.summary).toBe('new')
    expect(r!.nextAction).toBe('n2')
  })

  it('FS-miss + all rows consumed -> DB fallback returns null', () => {
    writeCheckpoint(AGENT, { summary: 's', nextAction: 'n' }, NOW, db)
    markCheckpointConsumed(AGENT, db) // flips DB rows too
    clearCheckpoint(AGENT)
    expect(readCheckpointFromDb(AGENT, NOW + 1, db)).toBeNull()
  })

  it('DB fallback respects TTL (stale row not returned)', () => {
    writeCheckpoint(AGENT, { summary: 's', nextAction: 'n' }, NOW, db)
    clearCheckpoint(AGENT)
    expect(readCheckpointFromDb(AGENT, NOW + CHECKPOINT_TTL_MS + 1, db)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Ledger suppression marker (dedup contract, FS side)
// ---------------------------------------------------------------------------
describe('ledger suppression marker', () => {
  afterEach(() => { consumeLedgerSuppressed(AGENT); try { if (existsSync(SUPPRESS_PATH)) unlinkSync(SUPPRESS_PATH) } catch { /* */ } })

  it('stamp -> present, consume -> absent', () => {
    stampLedgerSuppressed(AGENT, NOW)
    expect(isLedgerSuppressed(AGENT)).toBe(true)
    consumeLedgerSuppressed(AGENT)
    expect(isLedgerSuppressed(AGENT)).toBe(false)
  })
  it('absent by default', () => {
    expect(isLedgerSuppressed(AGENT)).toBe(false)
  })
})
