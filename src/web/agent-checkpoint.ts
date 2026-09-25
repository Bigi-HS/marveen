import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'
import { getNoaDb } from '../noa-db.js'
import type { BootClass } from './shutdown-marker.js'

// Per-agent durable CHECKPOINT (memory-continuity Phase 1, S3).
//
// A superset of the S2 task-state: it captures "what you can save" -- recent
// verbatim turns (lastTurns), a one-line focus, a brain-dump bucket
// (pendingObservations, STORE-ONLY in S3), and the folded task-state fields --
// so an agent resuming after a crash / compact / restart does not lose what
// happened just before. It does NOT replace agent-taskstate.ts yet; the two
// co-exist and the freshest UNCONSUMED checkpoint wins over bare task-state on
// crash-resume (see the /replay route).
//
// Durability (G2): the FS file store/agent-checkpoints/<agent>.json is PRIMARY;
// a throttled (>=30s) mirror row in noa.db `agent_checkpoints` is the crash
// backstop. On replay, an FS-miss/corrupt file falls back to the freshest
// unconsumed DB row.
//
// DEDUP / COMBINED-BUDGET contract (the whole slice's correctness): on a
// crash-resume the checkpoint `lastTurns` OVERLAPS the ledger-replay window
// (both carry the most-recent turns). They must NOT stack. When the checkpoint
// path injects lastTurns it stamps a one-boot SUPPRESSION MARKER that the
// ledger-replay hook consumes to skip its window for that boot; and the
// SessionStart continuity budget is capped COMBINED (~5-6k), not per-source.
//
// Fail-open + atomic throughout: a checkpoint write must NEVER throw into the
// agent turn. Safe direction inherited from S2: unknown/clean boot => no replay.

const STORE_DIR = join(PROJECT_ROOT, 'store', 'agent-checkpoints')

// TTL 48h: a checkpoint is a "recent state" snapshot; the consumed flag is the
// primary single-replay guard, so the TTL only sweeps a truly abandoned record.
export const CHECKPOINT_TTL_MS = 48 * 60 * 60 * 1000

// DB-mirror write throttle: the periodic mid-session tick can fire often, so the
// noa.db mirror is rate-limited to at most one write per 30s per agent. The FS
// file (primary) is always written; only the DB backstop is throttled.
export const CHECKPOINT_DB_THROTTLE_MS = 30 * 1000

// K = last 6 verbatim in/out turn pairs, per NoA-approved spec.
export const CHECKPOINT_LAST_TURNS_K = 6

// Hard char cap on the rendered lastTurns block (~4k chars, NoA). The SessionStart
// COMBINED continuity budget (ledger + checkpoint + memory-replay) is ~5-6k; the
// checkpoint's slice of that is capped here so it cannot alone blow the budget.
export const CHECKPOINT_LAST_TURNS_CHAR_CAP = 4000

// Same SessionStart sources the S2 task-state replays on unconditionally. A
// plain 'startup' is gated separately on the S1 crash marker (see
// shouldReplayCheckpoint): it resumes ONLY when the previous session crashed.
const REPLAY_SOURCES = new Set(['compact', 'resume'])

export interface TurnPair {
  in: string   // the user/inbound turn text
  out: string  // the agent/outbound turn text
}

export interface AgentCheckpoint {
  agent: string
  ts: number                    // epoch ms, written at PreCompact/SessionEnd/tick
  consumed: boolean             // set true AFTER a successful replay injection
  focus: string                 // 1-line "what I'm doing"
  lastTurns: TurnPair[]         // last K verbatim in/out pairs (K=6)
  pendingObservations: string[] // brain-dump bucket (STORE-ONLY in S3)
  // task-state fields folded in for the superset:
  doneSteps: string[]
  alreadyDelegated: string[]
  nextAction: string
  pendingDecision: string
  summary: string
}

function sanitizeAgent(agent: string): string {
  // The agent name becomes a filename -- allow only the safe charset.
  return agent.replace(/[^a-zA-Z0-9_-]/g, '')
}

function recordPath(agent: string): string {
  return join(STORE_DIR, `${sanitizeAgent(agent)}.json`)
}

// One-boot marker that tells the ledger-replay hook the checkpoint already
// supplied the recent-turns window this boot (dedup / suppression). Written by
// the /replay path when it injects lastTurns; consumed by ledger-replay.py.
function suppressMarkerPath(agent: string): string {
  return join(STORE_DIR, `${sanitizeAgent(agent)}.ledger-suppressed`)
}

function asStringArray(v: unknown, max = 50): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x).trim()).filter(Boolean).slice(0, max)
}

function asTurnPairs(v: unknown, max = CHECKPOINT_LAST_TURNS_K): TurnPair[] {
  if (!Array.isArray(v)) return []
  const out: TurnPair[] = []
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const inText = String(r.in ?? '').trim()
    const outText = String(r.out ?? '').trim()
    if (!inText && !outText) continue
    out.push({ in: inText, out: outText })
  }
  // Keep the most RECENT K (assume input is chronological, oldest-first).
  return out.slice(-max)
}

/**
 * Elide a single over-long turn text to head + tail so one huge turn cannot
 * dominate the cap. Keeps the first and last portions with a marker between.
 */
function elideTurn(text: string, budget: number): string {
  if (text.length <= budget) return text
  if (budget <= 12) return text.slice(0, Math.max(0, budget))
  const marker = ' [...] '
  const keep = budget - marker.length
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return text.slice(0, head) + marker + text.slice(text.length - tail)
}

/**
 * Render lastTurns to a bounded transcript block. OLDEST-first drop until the
 * total fits CHECKPOINT_LAST_TURNS_CHAR_CAP; a single turn still over the cap is
 * head+tail elided. Returns '' when there are no turns. Pure (no IO).
 */
export function renderLastTurns(
  turns: TurnPair[],
  charCap: number = CHECKPOINT_LAST_TURNS_CHAR_CAP,
): string {
  if (!turns.length) return ''
  // Render newest-K pairs to lines, chronological order.
  const pairs = turns.slice(-CHECKPOINT_LAST_TURNS_K)
  const lineOf = (p: TurnPair): string => {
    const parts: string[] = []
    if (p.in) parts.push(`  Be: "${p.in.replace(/\n/g, ' ')}"`)
    if (p.out) parts.push(`  Ki: "${p.out.replace(/\n/g, ' ')}"`)
    return parts.join('\n')
  }
  let lines = pairs.map(lineOf).filter(Boolean)
  // Drop OLDEST-first until within cap.
  const total = (ls: string[]) => ls.reduce((n, l) => n + l.length + 1, 0)
  while (lines.length > 1 && total(lines) > charCap) {
    lines.shift()
  }
  // A single remaining over-cap turn: elide head+tail.
  if (lines.length === 1 && lines[0].length > charCap) {
    lines = [elideTurn(lines[0], charCap)]
  }
  return lines.join('\n')
}

/** True when the checkpoint carries nothing worth replaying. */
export function isEmptyCheckpoint(
  r: Pick<AgentCheckpoint, 'lastTurns' | 'doneSteps' | 'alreadyDelegated' | 'nextAction' | 'pendingDecision' | 'focus'>,
): boolean {
  return (
    r.lastTurns.length === 0 &&
    r.doneSteps.length === 0 &&
    r.alreadyDelegated.length === 0 &&
    !r.nextAction.trim() &&
    !r.pendingDecision.trim() &&
    !r.focus.trim()
  )
}

/**
 * Pure decision: should this checkpoint be re-injected at SessionStart?
 * Mirrors shouldReplayTaskState exactly (S2 crash-gate):
 *   - compact | resume        -> always eligible.
 *   - startup + lastBoot=crash -> eligible (crash-resume).
 *   - startup + clean|unknown  -> NOT eligible (safe default).
 * Plus: record exists, not consumed, within TTL, and not empty.
 * lastBoot has no default: the caller MUST supply the S1 crash verdict.
 */
export function shouldReplayCheckpoint(
  record: AgentCheckpoint | null,
  source: string,
  lastBoot: BootClass,
  nowMs: number,
  ttlMs: number = CHECKPOINT_TTL_MS,
): boolean {
  if (!record) return false
  if (record.consumed) return false
  const sourceEligible = REPLAY_SOURCES.has(source) || (source === 'startup' && lastBoot === 'crash')
  if (!sourceEligible) return false
  if (nowMs - record.ts > ttlMs) return false
  if (isEmptyCheckpoint(record)) return false
  return true
}

const SENTINEL = '=== CHECKPOINT-FOLYTATAS (NEM uj feladat) ==='

/**
 * Build the additionalContext string for a checkpoint replay. Superset of the
 * task-state injection: adds the focus line and the bounded recent-turns window.
 * Pure (no IO). The recent-turns block is what OVERLAPS the ledger window --
 * whenever this returns a non-empty lastTurns block, the caller MUST suppress
 * the ledger window for that boot (dedup contract).
 */
export function buildCheckpointInjection(r: AgentCheckpoint): string {
  const lines: string[] = [
    SENTINEL,
    'A sessioned egy FOLYAMATBAN LEVO munka kozben ujraindult (crash/compact/restart). Ez NEM uj feladat -- FOLYTASD onnan ahol abbamaradt. NE INDITSD ujra a mar kesz lepeseket, es NE delegald ujra amit mar atadtal.',
  ]
  if (r.focus.trim()) lines.push(`FOKUSZ: ${r.focus.trim()}`)
  if (r.summary.trim()) lines.push(`FELADAT: ${r.summary.trim()}`)
  const turns = renderLastTurns(r.lastTurns)
  if (turns) lines.push('LEGUTOBBI FORDULOK (kontextus, idorendben):\n' + turns)
  if (r.doneSteps.length) lines.push('MAR KESZ (NE ismeteld meg):\n' + r.doneSteps.map((s) => `  - ${s}`).join('\n'))
  if (r.alreadyDelegated.length) lines.push('MAR DELEGALVA (NE kuldd ujra):\n' + r.alreadyDelegated.map((s) => `  - ${s}`).join('\n'))
  if (r.nextAction.trim()) lines.push(`KOVETKEZO AKCIO (innen folytasd): ${r.nextAction.trim()}`)
  if (r.pendingDecision.trim()) lines.push(`NYITOTT DONTES / BLOKKOLO: ${r.pendingDecision.trim()}`)
  return lines.join('\n\n')
}

/** Whether an injection actually carries a recent-turns window (=> suppress ledger). */
export function injectionHasLastTurns(r: AgentCheckpoint): boolean {
  return renderLastTurns(r.lastTurns).length > 0
}

function normalize(agent: string, raw: Partial<AgentCheckpoint>): AgentCheckpoint {
  return {
    agent: sanitizeAgent(agent),
    ts: typeof raw.ts === 'number' ? raw.ts : 0,
    consumed: raw.consumed === true,
    focus: String(raw.focus ?? '').trim(),
    lastTurns: asTurnPairs(raw.lastTurns),
    pendingObservations: asStringArray(raw.pendingObservations),
    doneSteps: asStringArray(raw.doneSteps),
    alreadyDelegated: asStringArray(raw.alreadyDelegated),
    nextAction: String(raw.nextAction ?? '').trim(),
    pendingDecision: String(raw.pendingDecision ?? '').trim(),
    summary: String(raw.summary ?? '').trim(),
  }
}

/**
 * Read the FS checkpoint for an agent.
 *   - absent -> null.
 *   - present but corrupt -> null (treated as ABSENT, fail-open; a corrupt file
 *     must NOT read as a false-crash resume -- the caller then falls back to the
 *     DB backstop, and if that too is empty, no replay happens).
 */
export function readCheckpoint(agent: string): AgentCheckpoint | null {
  const path = recordPath(agent)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AgentCheckpoint>
    return normalize(agent, raw)
  } catch (err) {
    logger.warn({ err, agent }, 'agent-checkpoint: unreadable record (treated as absent)')
    return null
  }
}

type WriteFields = Partial<Pick<
  AgentCheckpoint,
  'focus' | 'lastTurns' | 'pendingObservations' | 'doneSteps' | 'alreadyDelegated' | 'nextAction' | 'pendingDecision' | 'summary'
>>

/**
 * Write the checkpoint. FS is PRIMARY (always written, atomically). The DB
 * mirror is throttled (>=30s per agent) so the periodic tick cannot storm
 * noa.db. Always consumed:false + fresh ts, so a new write supersedes and
 * re-arms any prior one. Fail-open: a DB-mirror error is logged, never thrown
 * into the agent turn; the FS primary still succeeds.
 */
export function writeCheckpoint(
  agent: string,
  fields: WriteFields,
  nowMs: number,
  db: Database.Database = getNoaDb(),
): AgentCheckpoint {
  const record: AgentCheckpoint = normalize(agent, { ...fields, ts: nowMs, consumed: false })
  try {
    if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
    atomicWriteFileSync(recordPath(agent), JSON.stringify(record, null, 2))
  } catch (err) {
    logger.warn({ err, agent }, 'agent-checkpoint: FS write failed (fail-open)')
  }
  // DB mirror, throttled. Never throws into the turn.
  try {
    if (shouldWriteDbMirror(record.agent, nowMs, db)) mirrorToDb(record, db)
  } catch (err) {
    logger.warn({ err, agent }, 'agent-checkpoint: DB mirror failed (fail-open)')
  }
  return record
}

/** Mark the FS record consumed (single-replay guard). Best-effort. */
export function markCheckpointConsumed(agent: string, db: Database.Database = getNoaDb()): void {
  const r = readCheckpoint(agent)
  if (r) {
    r.consumed = true
    try { atomicWriteFileSync(recordPath(agent), JSON.stringify(r, null, 2)) } catch { /* best effort */ }
  }
  // Also flag the mirror row(s) so a later FS-miss fallback cannot re-serve it.
  try { markDbConsumed(sanitizeAgent(agent), db) } catch { /* best effort */ }
}

/** Explicit done-clear (secondary to consumed). Best-effort. */
export function clearCheckpoint(agent: string): void {
  try { const p = recordPath(agent); if (existsSync(p)) unlinkSync(p) } catch { /* best effort */ }
}

// ---- ledger suppression marker (dedup contract, FS side) ----

/** Stamp the one-boot ledger-suppression marker. Called when lastTurns injected. */
export function stampLedgerSuppressed(agent: string, nowMs: number): void {
  try {
    if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true })
    atomicWriteFileSync(suppressMarkerPath(agent), JSON.stringify({ ts: nowMs }))
  } catch (err) {
    logger.warn({ err, agent }, 'agent-checkpoint: ledger-suppress stamp failed (fail-open)')
  }
}

/** True iff the ledger-suppression marker exists (read side of the dedup contract). */
export function isLedgerSuppressed(agent: string): boolean {
  try { return existsSync(suppressMarkerPath(agent)) } catch { return false }
}

/** Consume (delete) the ledger-suppression marker so it only affects THIS boot. */
export function consumeLedgerSuppressed(agent: string): void {
  try { const p = suppressMarkerPath(agent); if (existsSync(p)) unlinkSync(p) } catch { /* best effort */ }
}

// ---- noa.db mirror (G2 durability backstop) ----

// Additive table only (database-designer: this is the new-table case, a plain
// CREATE TABLE IF NOT EXISTS boot migration -- NOT a rebuild). Column
// conventions mirror analytics_snapshots: INTEGER PK AUTOINCREMENT, epoch-ms as
// INTEGER, JSON payload as TEXT, snake_case, additive-only. Target = noa.db.
const CHECKPOINT_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS agent_checkpoints (
     id                   INTEGER PRIMARY KEY AUTOINCREMENT,
     agent_id             TEXT    NOT NULL,
     created_at           INTEGER NOT NULL,
     consumed             INTEGER NOT NULL DEFAULT 0,
     ttl_ms               INTEGER NOT NULL,
     focus                TEXT,
     last_turns           TEXT,
     pending_observations TEXT,
     done_steps           TEXT,
     already_delegated    TEXT,
     next_action          TEXT,
     pending_decision     TEXT,
     summary              TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_agent
     ON agent_checkpoints(agent_id, consumed, created_at)`,
]

/**
 * Idempotent additive migration for the noa.db checkpoint mirror. Wired into the
 * real server startup (web.ts) so a live noa.db gains the table on the next boot
 * -- NOT a fixture-only table. Each statement guarded so a partial schema never
 * bricks boot.
 */
export function applyCheckpointMigrations(db: Database.Database = getNoaDb()): void {
  for (const stmt of CHECKPOINT_MIGRATIONS) {
    try { db.exec(stmt) } catch (err) { logger.warn({ err }, 'agent-checkpoint: migration stmt failed') }
  }
}

/** True iff >=30s elapsed since this agent's freshest mirror row (throttle). */
export function shouldWriteDbMirror(
  agent: string,
  nowMs: number,
  db: Database.Database = getNoaDb(),
): boolean {
  try {
    const row = db.prepare(
      `SELECT created_at FROM agent_checkpoints WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(sanitizeAgent(agent)) as { created_at: number } | undefined
    if (!row) return true
    return nowMs - row.created_at >= CHECKPOINT_DB_THROTTLE_MS
  } catch {
    return false // DB unavailable -> skip the mirror (FS primary already wrote)
  }
}

function mirrorToDb(record: AgentCheckpoint, db: Database.Database): void {
  db.prepare(
    `INSERT INTO agent_checkpoints
       (agent_id, created_at, consumed, ttl_ms, focus, last_turns, pending_observations,
        done_steps, already_delegated, next_action, pending_decision, summary)
     VALUES
       (@agent_id, @created_at, @consumed, @ttl_ms, @focus, @last_turns, @pending_observations,
        @done_steps, @already_delegated, @next_action, @pending_decision, @summary)`,
  ).run({
    agent_id: record.agent,
    created_at: record.ts,
    consumed: 0,
    ttl_ms: CHECKPOINT_TTL_MS,
    focus: record.focus || null,
    last_turns: JSON.stringify(record.lastTurns),
    pending_observations: JSON.stringify(record.pendingObservations),
    done_steps: JSON.stringify(record.doneSteps),
    already_delegated: JSON.stringify(record.alreadyDelegated),
    next_action: record.nextAction || null,
    pending_decision: record.pendingDecision || null,
    summary: record.summary || null,
  })
}

function markDbConsumed(agent: string, db: Database.Database): void {
  db.prepare(`UPDATE agent_checkpoints SET consumed = 1 WHERE agent_id = ? AND consumed = 0`).run(agent)
}

/**
 * FS-miss/corrupt fallback: return the freshest UNCONSUMED, within-TTL mirror
 * row as an AgentCheckpoint, or null. This is the crash backstop when the FS
 * primary is wiped. Never throws.
 */
export function readCheckpointFromDb(
  agent: string,
  nowMs: number,
  db: Database.Database = getNoaDb(),
): AgentCheckpoint | null {
  try {
    const row = db.prepare(
      `SELECT * FROM agent_checkpoints
        WHERE agent_id = ? AND consumed = 0 AND (? - created_at) <= ttl_ms
        ORDER BY created_at DESC LIMIT 1`,
    ).get(sanitizeAgent(agent), nowMs) as Record<string, unknown> | undefined
    if (!row) return null
    return normalize(agent, {
      ts: Number(row.created_at),
      consumed: Number(row.consumed) === 1,
      focus: (row.focus as string) ?? '',
      // normalize() re-validates via asTurnPairs/asStringArray, so the parsed
      // JSON is passed through untyped -- the shape is enforced downstream.
      lastTurns: safeParse(row.last_turns) as TurnPair[],
      pendingObservations: safeParse(row.pending_observations) as string[],
      doneSteps: safeParse(row.done_steps) as string[],
      alreadyDelegated: safeParse(row.already_delegated) as string[],
      nextAction: (row.next_action as string) ?? '',
      pendingDecision: (row.pending_decision as string) ?? '',
      summary: (row.summary as string) ?? '',
    })
  } catch (err) {
    logger.warn({ err, agent }, 'agent-checkpoint: DB fallback read failed')
    return null
  }
}

function safeParse(v: unknown): unknown {
  if (typeof v !== 'string' || !v) return []
  try { return JSON.parse(v) } catch { return [] }
}

/**
 * Resolve the checkpoint to replay: FS primary, else the freshest unconsumed DB
 * row (G2 crash backstop). Pure-ish (reads only). Returns null when neither has
 * a live record.
 */
export function resolveCheckpoint(
  agent: string,
  nowMs: number,
  db: Database.Database = getNoaDb(),
): AgentCheckpoint | null {
  const fs = readCheckpoint(agent)
  if (fs) return fs
  return readCheckpointFromDb(agent, nowMs, db)
}
