import { statSync, readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { getDb, startOfBudapestDayMs } from '../db.js'
import { getNoaDb } from '../noa-memory.js'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID, FABLE_DAILY_TOKEN_CEILING } from '../config.js'
import { costForUsageDetailedUsd, readAgentModel, listAgentNames } from './agent-config.js'
import { FABLE_MODEL_TAGS, isFableModel } from '../fable-config.js'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// A workflow phantom sub-agent writes its transcript under the orchestrating
// session's project dir, in a `subagents/` subtree (card bb4992dc, verified:
// <projectDir>/<parentSessionUuid>/subagents/agent-<id>.jsonl). Any file on such
// a path is a child of the source agent; everything else is the agent's own
// session. The check is path-segment based (not a basename/prefix match) so a
// dir literally named with an `agent-foo` vs `agent-foobar` prefix can never be
// misclassified. Returns the parent agent id for a child, else null.
export function spawnedByForFile(agent: string, filePath: string): string | null {
  return filePath.includes('/subagents/') ? agent : null
}

interface AgentTranscriptSource {
  agent: string
  projectDir: string
}

function discoverAgentSources(): AgentTranscriptSource[] {
  const sources: AgentTranscriptSource[] = []
  if (!existsSync(PROJECTS_DIR)) return sources
  for (const entry of readdirSync(PROJECTS_DIR)) {
    const full = join(PROJECTS_DIR, entry)
    let stat
    try { stat = statSync(full) } catch { continue }
    if (!stat.isDirectory()) continue

    const agentMatch = entry.match(/-agents-([a-z]+)$/)
    if (agentMatch) {
      sources.push({ agent: agentMatch[1], projectDir: full })
    } else if (entry.includes(`-${MAIN_AGENT_ID}`) && !entry.includes('-agents-')) {
      sources.push({ agent: MAIN_AGENT_ID, projectDir: full })
    }
  }
  return sources
}

function findJsonlFiles(dir: string): string[] {
  const files: string[] = []
  if (!existsSync(dir)) return files

  function scanDir(d: string) {
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const entry of entries) {
      const full = join(d, entry)
      if (entry.endsWith('.jsonl')) {
        files.push(full)
      } else {
        let stat
        try { stat = statSync(full) } catch { continue }
        if (stat.isDirectory()) {
          scanDir(full)
        }
      }
    }
  }

  scanDir(dir)
  return files
}

interface ParsedCall {
  agent: string
  sessionId: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  contentPreview: string
  toolName: string | null
  model: string | null
  spawnedBy: string | null
}

async function parseJsonlFile(
  filePath: string,
  agent: string,
  fromLine: number,
): Promise<{ calls: ParsedCall[]; linesRead: number }> {
  const calls: ParsedCall[] = []
  let lineNum = 0
  let sessionId = ''
  // Per-file (not per-line): the lineage is a property of where the transcript
  // lives, so compute it once.
  const spawnedBy = spawnedByForFile(agent, filePath)

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    lineNum++
    if (lineNum <= fromLine) continue
    if (!line.trim()) continue

    let obj: any
    try { obj = JSON.parse(line) } catch { continue }

    if (obj.sessionId) {
      sessionId = obj.sessionId
    }

    if (obj.type !== 'assistant' || !obj.message?.usage) continue

    const u = obj.message.usage
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0
    if (!ts) continue

    let preview = ''
    const content = obj.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          preview = block.text.slice(0, 200)
          break
        }
      }
    } else if (typeof content === 'string') {
      preview = content.slice(0, 200)
    }

    let toolName: string | null = null
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use' && block.name) {
          toolName = block.name
          break
        }
      }
    }

    const model: string | null = typeof obj.message?.model === 'string' ? obj.message.model : null

    calls.push({
      agent,
      sessionId: sessionId || basename(filePath, '.jsonl'),
      timestamp: Math.floor(ts / 1000),
      inputTokens: (u.input_tokens || 0),
      outputTokens: (u.output_tokens || 0),
      cacheReadTokens: (u.cache_read_input_tokens || 0),
      cacheCreationTokens: (u.cache_creation_input_tokens || 0),
      contentPreview: preview,
      toolName,
      model,
      spawnedBy,
    })
  }

  return { calls, linesRead: lineNum }
}

// Prepared statements for one collect pass. Built once and reused across files
// (see ingestJsonlFile) so the hot loop never re-prepares. Exported alongside
// ingestJsonlFile so the cursor idempotency path is unit-testable on one file
// without mocking the module-level PROJECTS_DIR (card 3f674c34 C5b).
// Statement<unknown[]> keeps run(...params) variadic; ReturnType over db.prepare
// resolves through the generic constraint and collapses to a 1-arg tuple instead.
type PreparedStmt = import('better-sqlite3').Statement<unknown[]>
export interface TokenUsageStmts {
  getCursor: PreparedStmt
  setCursor: PreparedStmt
  insertCall: PreparedStmt
  backfillAttribution: PreparedStmt
}

export function prepareTokenUsageStmts(db: ReturnType<typeof getDb>): TokenUsageStmts {
  return {
    getCursor: db.prepare('SELECT last_line, last_size FROM token_usage_cursors WHERE file_path = ?'),
    setCursor: db.prepare('INSERT OR REPLACE INTO token_usage_cursors (file_path, last_line, last_size) VALUES (?, ?, ?)'),
    insertCall: db.prepare(`
      INSERT OR IGNORE INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, content_preview, tool_name, model, spawned_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    // On a re-ingest the row already exists, so INSERT OR IGNORE is a no-op; this
    // backfills the new attribution columns onto a pre-existing row keyed by the
    // dedup tuple. NULL-coalesced so a re-parse never clobbers a known value.
    backfillAttribution: db.prepare(`
      UPDATE token_usage SET model = COALESCE(model, ?), spawned_by = COALESCE(spawned_by, ?)
      WHERE agent = ? AND session_id = ? AND timestamp = ? AND input_tokens = ? AND output_tokens = ?
        AND (model IS NULL OR spawned_by IS NULL)
    `),
  }
}

// Ingest a single transcript file. Idempotent by construction: the cursor
// (file_path -> last_line, last_size) skips an unchanged file and resumes an
// appended one from where it stopped, while the UNIQUE dedup index +
// INSERT OR IGNORE make any overlapping re-read count each tuple exactly once.
// `processed` mirrors the old totalFiles++ (a parse actually ran; false on a
// stat failure or an unchanged-file skip). Stmts are shared across files by the
// caller; a lone call self-prepares (used by tests).
export async function ingestJsonlFile(
  db: ReturnType<typeof getDb>,
  file: string,
  agent: string,
  stmts: TokenUsageStmts = prepareTokenUsageStmts(db),
): Promise<{ inserted: number; processed: boolean }> {
  let fileSize: number
  try { fileSize = statSync(file).size } catch { return { inserted: 0, processed: false } }

  const cursor = stmts.getCursor.get(file) as { last_line: number; last_size: number } | undefined
  if (cursor && cursor.last_size === fileSize) return { inserted: 0, processed: false }

  const fromLine = (cursor && cursor.last_size <= fileSize) ? cursor.last_line : 0

  try {
    const { calls, linesRead } = await parseJsonlFile(file, agent, fromLine)

    if (calls.length > 0) {
      const tx = db.transaction(() => {
        for (const c of calls) {
          stmts.insertCall.run(
            c.agent, c.sessionId, c.timestamp,
            c.inputTokens, c.outputTokens,
            c.cacheReadTokens, c.cacheCreationTokens,
            c.contentPreview || null, c.toolName, c.model, c.spawnedBy,
          )
          if (c.model !== null || c.spawnedBy !== null) {
            stmts.backfillAttribution.run(
              c.model, c.spawnedBy,
              c.agent, c.sessionId, c.timestamp, c.inputTokens, c.outputTokens,
            )
          }
        }
        stmts.setCursor.run(file, linesRead, fileSize)
      })
      tx()
      return { inserted: calls.length, processed: true }
    }
    stmts.setCursor.run(file, linesRead, fileSize)
    return { inserted: 0, processed: true }
  } catch (err) {
    logger.warn({ err, file }, 'Token usage parse failed')
    return { inserted: 0, processed: false }
  }
}

export async function collectTokenUsage(
  opts: { reparse?: boolean } = {},
): Promise<{ inserted: number; files: number }> {
  const db = getDb()
  const sources = discoverAgentSources()
  let totalInserted = 0
  let totalFiles = 0

  // Opt-in clean re-ingest (card bb4992dc backfill): wipe the cursors so every
  // transcript is re-parsed from line 0. Safe because the unique dedup index +
  // INSERT OR IGNORE make a re-read idempotent, while NEW columns (model,
  // spawned_by) on rows that already existed get filled by the UPDATE below.
  if (opts.reparse) db.exec('DELETE FROM token_usage_cursors')

  const stmts = prepareTokenUsageStmts(db)

  for (const source of sources) {
    const files = findJsonlFiles(source.projectDir)
    for (const file of files) {
      const { inserted, processed } = await ingestJsonlFile(db, file, source.agent, stmts)
      totalInserted += inserted
      if (processed) totalFiles++
    }
  }

  return { inserted: totalInserted, files: totalFiles }
}

export interface TokenSummary {
  agent: string
  totalCalls: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
  firstSeen: number
  lastSeen: number
  /** Cache-aware USD cost across all four token components, priced per-row at
   * each row's own model (card bb4992dc). Rows with no captured model are priced
   * at the agent's configured model as a fallback; rows whose model stays
   * unknown contribute 0 (cannot be priced). */
  totalCostUsd: number
}

// Per (agent, model) raw aggregate -- the grain at which cost must be computed,
// since each model prices differently. Re-aggregated to per-agent in JS.
interface AgentModelGroup {
  agent: string
  model: string | null
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  firstSeen: number
  lastSeen: number
}

// Price one (agent, model) group, falling back to the agent's configured model
// when the row carried no model (legacy rows). Returns 0 when still unpriceable.
function costForGroup(g: { agent: string; model: string | null; input: number; output: number; cacheRead: number; cacheCreation: number }): number {
  const model = g.model ?? readAgentModel(g.agent)
  const cost = costForUsageDetailedUsd(model, {
    input: g.input, output: g.output, cacheRead: g.cacheRead, cacheCreation: g.cacheCreation,
  })
  return cost ?? 0
}

function timeFilter(from?: number, to?: number): { clause: string; params: any[] } {
  const conditions: string[] = []
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  return { clause: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '', params }
}

// --- Fable safety-net F1 slice-2: telemetry liveness / stale flag ---
// The collector feeding token_usage has silently stalled before (~5h gap, card
// d1ca8650). A safety-net reading a blind stream must fail CONSERVATIVELY: an
// empty table or a most-recent row older than the window reports stale=true, so
// downstream guards never mistake "no data" for "no spend". Model-agnostic --
// this only looks at recency, not which model produced the rows.
export const TOKEN_USAGE_DEFAULT_STALE_MS = 20 * 60 * 1000

export interface TokenUsageLiveness {
  /** Epoch SECONDS of the most recent token_usage row, or null if the table is empty. */
  lastTimestamp: number | null
  /** now - lastTimestamp (ms), or null when there are no rows. */
  ageMs: number | null
  /** True when there is no fresh data: no rows at all, or age strictly beyond the threshold. */
  stale: boolean
  /** The threshold used for the stale decision (ms). */
  staleThresholdMs: number
  /** The "now" (epoch ms) the decision was made against. */
  now: number
  /** Whether any row exists at all (distinguishes "blind" from "merely old"). */
  rowsSeen: boolean
}

export function getTokenUsageLiveness(
  opts: { nowMs?: number; staleThresholdMs?: number } = {},
): TokenUsageLiveness {
  const now = opts.nowMs ?? Date.now()
  const staleThresholdMs = opts.staleThresholdMs ?? TOKEN_USAGE_DEFAULT_STALE_MS
  const db = getDb()
  const row = db.prepare('SELECT MAX(timestamp) as maxTs FROM token_usage').get() as
    | { maxTs: number | null }
    | undefined
  const lastTimestamp = row?.maxTs ?? null
  const rowsSeen = lastTimestamp !== null
  // token_usage.timestamp is epoch SECONDS (Math.floor(ts/1000) at ingest).
  const ageMs = rowsSeen ? now - lastTimestamp * 1000 : null
  const stale = !rowsSeen || (ageMs as number) > staleThresholdMs
  return { lastTimestamp, ageMs, stale, staleThresholdMs, now, rowsSeen }
}

// --- Fable safety-net F1 slice-3: fable-only budget windows ---
// Fable runs on the Max-plan quota, not per-token billing, so the actionable
// currency is TOKENS / requests; costUsd is best-effort (fable is unpriced in the
// model registry -> 0). Aggregation is a direct DB window-query (SUM/GROUP BY over
// the window), never the limit-capped detail endpoint which would silently
// truncate historical rows. Model filtering goes through the shared FABLE_MODEL_TAGS
// single source of truth (card d1ca8650).

export interface FableWindowAgg {
  /** Window bounds, epoch SECONDS, inclusive. */
  from: number
  to: number
  windowHours: number
  /** Fable requests (rows) in the window. */
  rows: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  /** Best-effort USD (0 while fable is unpriced in the registry); never negative. */
  costUsd: number
  burnRateTokensPerHour: number
  burnRateUsdPerHour: number
}

export interface FableBudget {
  now: number
  tags: string[]
  /** Agents currently configured on a fable model (drives the blind flag). */
  agentsOnFable: string[]
  /** Fail-safe: an agent is on fable but no fable rows are visible in the week window. */
  blind: boolean
  /** All-time fable row count (has the stream EVER carried fable telemetry?). */
  fableRowsSeenTotal: number
  /** Untagged spend from fable-configured agents in the week window: rows whose
   *  model is NULL, so fableWindowAgg (which matches by model tag) silently drops
   *  them and fable spend may be under-counted (card 3f674c34 C6a). Fable-SCOPED
   *  via agentsOnFable, the clean agent->fable config mapping (readAgentModel /
   *  agent-config), not a guess. LIMIT: a row carrying a deliberate non-fable
   *  model tag is NOT flagged -- it is indistinguishable from a fable-configured
   *  agent legitimately running another model, so only the missing-tag (NULL)
   *  case is surfaced. `blind` still covers the TOTAL-zero case. */
  possiblyUntagged: { rows: number; tokens: number; agents: string[] }
  fiveHour: FableWindowAgg
  today: FableWindowAgg
  week: FableWindowAgg
}

// Budapest local midnight (epoch seconds) for the instant nowMs. Delegates to the
// shared DST-exact `startOfBudapestDayMs` (db.ts, Intl + tzOffsetSeconds) so the
// daily window boundary is correct across DST transitions (card 3f674c34 C6-TZ);
// the previous local toLocaleString offset trick could be off by the 1h shift.
function startOfBudapestDaySeconds(nowMs: number): number {
  return Math.floor(startOfBudapestDayMs(nowMs) / 1000)
}

function fableWindowAgg(db: ReturnType<typeof getDb>, fromSec: number, toSec: number): FableWindowAgg {
  const likeClause = FABLE_MODEL_TAGS.map(() => 'model LIKE ?').join(' OR ')
  const likeParams = FABLE_MODEL_TAGS.map((t) => t + '%')
  const groups = db.prepare(`
    SELECT model,
      COUNT(*) as rows,
      COALESCE(SUM(input_tokens), 0) as input,
      COALESCE(SUM(output_tokens), 0) as output,
      COALESCE(SUM(cache_read_tokens), 0) as cacheRead,
      COALESCE(SUM(cache_creation_tokens), 0) as cacheCreation
    FROM token_usage
    WHERE timestamp >= ? AND timestamp <= ? AND (${likeClause})
    GROUP BY model
  `).all(fromSec, toSec, ...likeParams) as Array<{
    model: string; rows: number; input: number; output: number; cacheRead: number; cacheCreation: number
  }>

  let rows = 0, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheCreationTokens = 0, costUsd = 0
  for (const g of groups) {
    rows += g.rows
    inputTokens += g.input
    outputTokens += g.output
    cacheReadTokens += g.cacheRead
    cacheCreationTokens += g.cacheCreation
    // Each model prices at its own rate (fable -> null -> 0 until priced).
    costUsd += costForUsageDetailedUsd(g.model, {
      input: g.input, output: g.output, cacheRead: g.cacheRead, cacheCreation: g.cacheCreation,
    }) ?? 0
  }
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens
  const windowHours = Math.max(0, (toSec - fromSec) / 3600)
  const burnRateTokensPerHour = windowHours > 0 ? totalTokens / windowHours : 0
  const burnRateUsdPerHour = windowHours > 0 ? costUsd / windowHours : 0
  return {
    from: fromSec, to: toSec, windowHours, rows,
    inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalTokens,
    costUsd, burnRateTokensPerHour, burnRateUsdPerHour,
  }
}

// Rows in [fromSec, toSec] from fable-configured agents whose model is NULL
// (untagged) -> silently excluded from fableWindowAgg's model-tag match. A
// non-zero count means real fable spend may be under-counted (card 3f674c34 C6a).
function possiblyUntaggedFable(
  db: ReturnType<typeof getDb>,
  fromSec: number,
  toSec: number,
  agentsOnFable: string[],
): { rows: number; tokens: number; agents: string[] } {
  if (agentsOnFable.length === 0) return { rows: 0, tokens: 0, agents: [] }
  const placeholders = agentsOnFable.map(() => '?').join(',')
  const groups = db.prepare(`
    SELECT agent,
      COUNT(*) as rows,
      COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) as tokens
    FROM token_usage
    WHERE timestamp >= ? AND timestamp <= ? AND model IS NULL AND agent IN (${placeholders})
    GROUP BY agent
  `).all(fromSec, toSec, ...agentsOnFable) as Array<{ agent: string; rows: number; tokens: number }>

  let rows = 0, tokens = 0
  const agents: string[] = []
  for (const g of groups) {
    rows += g.rows
    tokens += g.tokens
    agents.push(g.agent)
  }
  return { rows, tokens, agents }
}

export function getFableBudget(opts: { nowMs?: number; agentsOnFable?: string[] } = {}): FableBudget {
  const now = opts.nowMs ?? Date.now()
  const nowSec = Math.floor(now / 1000)
  const db = getDb()

  const agentsOnFable = opts.agentsOnFable
    ?? listAgentNames().filter((a) => isFableModel(readAgentModel(a)))

  const likeClause = FABLE_MODEL_TAGS.map(() => 'model LIKE ?').join(' OR ')
  const likeParams = FABLE_MODEL_TAGS.map((t) => t + '%')
  const totalRow = db.prepare(
    `SELECT COUNT(*) as n FROM token_usage WHERE ${likeClause}`,
  ).get(...likeParams) as { n: number } | undefined
  const fableRowsSeenTotal = totalRow?.n ?? 0

  const fiveHour = fableWindowAgg(db, nowSec - 5 * 3600, nowSec)
  const today = fableWindowAgg(db, startOfBudapestDaySeconds(now), nowSec)
  const week = fableWindowAgg(db, nowSec - 7 * 86400, nowSec)

  const blind = agentsOnFable.length > 0 && week.rows === 0
  const possiblyUntagged = possiblyUntaggedFable(db, nowSec - 7 * 86400, nowSec, agentsOnFable)

  return { now, tags: [...FABLE_MODEL_TAGS], agentsOnFable, blind, fableRowsSeenTotal, possiblyUntagged, fiveHour, today, week }
}

// --- Fable safety-net F1 slice-4: configurable daily ceiling + restrict signal ---
// Adds an operator-set daily fable TOKEN ceiling on top of the budget windows.
// restrict = exceeded OR blind, so a downstream watchdog (F2 auto-revert, Forge)
// can poll one boolean.
//
// DORMANT-CAP NOTE (intentional in F1, per card d1ca8650 design): the absolute
// Max-plan fable quota is opaque, so we ship NO guessed ceiling -- the default is
// 0 = DISABLED. With the ceiling disabled the CONSUMPTION-CAP is dormant
// (exceeded/warn can never trip) and ONLY the blind-restrict fail-safe is active.
// This is visibility-first: at the current moderate real spend there is no
// urgency for a hard cap, and a guessed number would only cause false-positive
// restricts. The hard cap wakes once the ceiling is calibrated from real
// burn-rate data (follow-up F1.5) and the F2 auto-revert lands.
export const FABLE_BUDGET_WARN_RATIO = 0.8

export interface FableBudgetStatus extends FableBudget {
  /** Operator-set daily fable token budget; null when disabled (dormant cap). */
  ceiling: { dailyTotalTokens: number | null }
  warnRatio: number
  /** today >= warnRatio * ceiling (only meaningful when the ceiling is set). */
  warn: boolean
  /** today >= ceiling (only when the ceiling is set). */
  exceeded: boolean
  /** The one boolean a watchdog polls: exceeded OR blind. */
  restrict: boolean
}

export function getFableBudgetStatus(
  opts: { nowMs?: number; agentsOnFable?: string[]; dailyTokenCeiling?: number | null; warnRatio?: number } = {},
): FableBudgetStatus {
  const budget = getFableBudget({ nowMs: opts.nowMs, agentsOnFable: opts.agentsOnFable })
  const rawCeiling = opts.dailyTokenCeiling ?? FABLE_DAILY_TOKEN_CEILING
  const ceiling = rawCeiling && rawCeiling > 0 ? rawCeiling : null
  const warnRatio = opts.warnRatio ?? FABLE_BUDGET_WARN_RATIO
  const todayTokens = budget.today.totalTokens
  const exceeded = ceiling !== null && todayTokens >= ceiling
  const warn = ceiling !== null && todayTokens >= ceiling * warnRatio
  const restrict = exceeded || budget.blind
  return { ...budget, ceiling: { dailyTotalTokens: ceiling }, warnRatio, warn, exceeded, restrict }
}

export function getTokenSummary(from?: number, to?: number): TokenSummary[] {
  const db = getDb()
  const { clause, params } = timeFilter(from, to)
  const sql = `
    SELECT agent, model,
      COUNT(*) as calls,
      SUM(input_tokens) as input,
      SUM(output_tokens) as output,
      SUM(cache_read_tokens) as cacheRead,
      SUM(cache_creation_tokens) as cacheCreation,
      MIN(timestamp) as firstSeen,
      MAX(timestamp) as lastSeen
    FROM token_usage${clause}
    GROUP BY agent, model
  `
  const groups = db.prepare(sql).all(...params) as AgentModelGroup[]

  // Re-aggregate the per-(agent,model) groups into one row per agent, summing the
  // per-model cost so each model prices at its own rate.
  const byAgent = new Map<string, TokenSummary>()
  for (const g of groups) {
    let s = byAgent.get(g.agent)
    if (!s) {
      s = {
        agent: g.agent, totalCalls: 0, totalInput: 0, totalOutput: 0,
        totalCacheRead: 0, totalCacheCreation: 0,
        firstSeen: g.firstSeen, lastSeen: g.lastSeen, totalCostUsd: 0,
      }
      byAgent.set(g.agent, s)
    }
    s.totalCalls += g.calls
    s.totalInput += g.input
    s.totalOutput += g.output
    s.totalCacheRead += g.cacheRead
    s.totalCacheCreation += g.cacheCreation
    s.firstSeen = Math.min(s.firstSeen, g.firstSeen)
    s.lastSeen = Math.max(s.lastSeen, g.lastSeen)
    s.totalCostUsd += costForGroup(g)
  }

  return [...byAgent.values()].sort((a, b) => b.totalInput - a.totalInput)
}

// One (agent, effective-model) group whose spend could NOT be priced -- the model
// is absent from the rate registry (unknown or renamed) yet carried real tokens.
// costForGroup swallows this as $0 (`cost ?? 0`), so the spend silently disappears
// from every USD rollup. Surfacing it turns an invisible $0 into a visible signal
// (card 3f674c34 C5a). Fable is intentionally unpriced and is NOT "unrated".
export interface UnratedModelUsage {
  agent: string
  /** Effective model that failed to price (the row's own model, else the agent's
   *  configured fallback). */
  model: string | null
  calls: number
  totalTokens: number
}

export function getUnratedModels(from?: number, to?: number): UnratedModelUsage[] {
  const db = getDb()
  const { clause, params } = timeFilter(from, to)
  const groups = db.prepare(`
    SELECT agent, model,
      COUNT(*) as calls,
      SUM(input_tokens) as input,
      SUM(output_tokens) as output,
      SUM(cache_read_tokens) as cacheRead,
      SUM(cache_creation_tokens) as cacheCreation
    FROM token_usage${clause}
    GROUP BY agent, model
  `).all(...params) as Array<{
    agent: string; model: string | null
    calls: number; input: number; output: number; cacheRead: number; cacheCreation: number
  }>

  const unrated: UnratedModelUsage[] = []
  for (const g of groups) {
    // Same fallback chain as costForGroup, so we flag exactly what pricing sees.
    const model = g.model ?? readAgentModel(g.agent)
    if (isFableModel(model)) continue // fable is unpriced by design, not "unrated"
    const cost = costForUsageDetailedUsd(model, {
      input: g.input, output: g.output, cacheRead: g.cacheRead, cacheCreation: g.cacheCreation,
    })
    if (cost !== null) continue // priced fine
    const totalTokens = g.input + g.output + g.cacheRead + g.cacheCreation
    if (totalTokens <= 0) continue // nothing to price anyway
    unrated.push({ agent: g.agent, model, calls: g.calls, totalTokens })
  }
  return unrated.sort((a, b) => b.totalTokens - a.totalTokens)
}

export interface SessionCost {
  agent: string
  sessionId: string
  spawnedBy: string | null
  calls: number
  totalInput: number
  totalOutput: number
  totalCacheRead: number
  totalCacheCreation: number
  costUsd: number
}

// Per-session cost rollup (card bb4992dc). Priced per (session, model) then
// summed per session, with the same configured-model fallback. `spawnedBy` is
// carried through so the caller can tell a phantom child's session apart from a
// top-level one.
export function getCostBySession(opts: { agent?: string; from?: number; to?: number } = {}): SessionCost[] {
  const db = getDb()
  const conditions: string[] = []
  const params: any[] = []
  if (opts.agent) { conditions.push('agent = ?'); params.push(opts.agent) }
  if (opts.from) { conditions.push('timestamp >= ?'); params.push(opts.from) }
  if (opts.to) { conditions.push('timestamp <= ?'); params.push(opts.to) }
  const clause = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''
  const rows = db.prepare(`
    SELECT agent, session_id as sessionId, spawned_by as spawnedBy, model,
      COUNT(*) as calls,
      SUM(input_tokens) as input, SUM(output_tokens) as output,
      SUM(cache_read_tokens) as cacheRead, SUM(cache_creation_tokens) as cacheCreation
    FROM token_usage${clause}
    GROUP BY agent, session_id, spawned_by, model
  `).all(...params) as (AgentModelGroup & { sessionId: string; spawnedBy: string | null })[]

  const bySession = new Map<string, SessionCost>()
  for (const r of rows) {
    // Composite Map key only (never persisted, never returned). The separator
    // used to be a literal NUL, which made this whole FILE unsearchable:
    // GNU grep calls any file containing a NUL binary, prints no matching
    // lines, and sends its only notice to stderr -- which every audit
    // one-liner discards with 2>/dev/null (DA-57, card OPS/5a719242).
    // U+001F keeps the same "cannot occur in an agent id or a session id"
    // property without taking the file out of every content search.
    const key = `${r.agent}\u001f${r.sessionId}`
    let s = bySession.get(key)
    if (!s) {
      s = {
        agent: r.agent, sessionId: r.sessionId, spawnedBy: r.spawnedBy, calls: 0,
        totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheCreation: 0, costUsd: 0,
      }
      bySession.set(key, s)
    }
    s.calls += r.calls
    s.totalInput += r.input
    s.totalOutput += r.output
    s.totalCacheRead += r.cacheRead
    s.totalCacheCreation += r.cacheCreation
    s.costUsd += costForGroup(r)
    if (r.spawnedBy && !s.spawnedBy) s.spawnedBy = r.spawnedBy
  }
  return [...bySession.values()].sort((a, b) => b.costUsd - a.costUsd)
}

export interface LineageRollup {
  parent: string
  childCalls: number
  childSessions: number
  childCostUsd: number
}

// One-level parent->child cost rollup (card bb4992dc): for each orchestrating
// agent that spawned workflow phantoms, the total cost its children incurred,
// separable from the parent's own-session spend. Only rows with a non-null
// spawned_by (the phantom children) count here.
export function getLineageRollup(from?: number, to?: number): LineageRollup[] {
  const sessions = getCostBySession({ from, to }).filter(s => s.spawnedBy)
  const byParent = new Map<string, LineageRollup>()
  for (const s of sessions) {
    const parent = s.spawnedBy as string
    let r = byParent.get(parent)
    if (!r) { r = { parent, childCalls: 0, childSessions: 0, childCostUsd: 0 }; byParent.set(parent, r) }
    r.childCalls += s.calls
    r.childSessions += 1
    r.childCostUsd += s.costUsd
  }
  return [...byParent.values()].sort((a, b) => b.childCostUsd - a.childCostUsd)
}

export interface TimelineBucket {
  bucket: number
  agent: string
  calls: number
  inputTokens: number
  outputTokens: number
  /** Cache-aware USD cost for this bucket, priced per (bucket, agent, model) then
   * summed, so each model prices at its own rate (same discipline as
   * getTokenSummary). Server-side to avoid ever hardcoding prices in the UI. */
  costUsd: number
}

// SQL grain for the timeline: per (bucket, agent, model) so cost can be priced at
// each row's own model, then re-aggregated to per (bucket, agent) in JS.
interface TimelineModelRow {
  bucket: number
  agent: string
  model: string | null
  calls: number
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheCreation: number
}

export function getTokenTimeline(
  bucketMinutes: number = 60,
  from?: number,
  to?: number,
  agent?: string,
): TimelineBucket[] {
  const db = getDb()
  const bucketSeconds = bucketMinutes * 60
  let sql = `
    SELECT
      (timestamp / ${bucketSeconds}) * ${bucketSeconds} as bucket,
      agent,
      model,
      COUNT(*) as calls,
      SUM(input_tokens + cache_read_tokens + cache_creation_tokens) as inputTokens,
      SUM(output_tokens) as outputTokens,
      SUM(input_tokens) as rawInput,
      SUM(cache_read_tokens) as cacheRead,
      SUM(cache_creation_tokens) as cacheCreation
    FROM token_usage
  `
  const conditions: string[] = []
  const params: any[] = []
  if (from) { conditions.push('timestamp >= ?'); params.push(from) }
  if (to) { conditions.push('timestamp <= ?'); params.push(to) }
  if (agent) { conditions.push('agent = ?'); params.push(agent) }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' GROUP BY bucket, agent, model ORDER BY bucket ASC'

  const rows = db.prepare(sql).all(...params) as (TimelineModelRow & { rawInput: number })[]

  // Re-aggregate per (bucket, agent), summing the per-model cost. inputTokens
  // already includes cache tokens for the chart; cost is priced from the raw
  // components (rawInput/output/cacheRead/cacheCreation) at each row's model.
  const byKey = new Map<string, TimelineBucket>()
  for (const r of rows) {
    const key = `${r.bucket} ${r.agent}`
    let b = byKey.get(key)
    if (!b) {
      b = { bucket: r.bucket, agent: r.agent, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
      byKey.set(key, b)
    }
    b.calls += r.calls
    b.inputTokens += r.inputTokens
    b.outputTokens += r.outputTokens
    b.costUsd += costForGroup({
      agent: r.agent, model: r.model,
      input: r.rawInput, output: r.outputTokens,
      cacheRead: r.cacheRead, cacheCreation: r.cacheCreation,
    })
  }
  return [...byKey.values()].sort((a, b) => a.bucket - b.bucket)
}

export interface TokenDetail {
  id: number
  agent: string
  sessionId: string
  timestamp: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  contentPreview: string | null
  toolName: string | null
  taskTitle: string | null
  project: string | null
}

export function getTokenDetails(
  opts: { agent?: string; from?: number; to?: number; limit?: number; offset?: number; minTokens?: number; q?: string },
): TokenDetail[] {
  const db = getDb()
  let sql = `SELECT * FROM token_usage`
  const conditions: string[] = []
  const params: any[] = []
  if (opts.agent) { conditions.push('agent = ?'); params.push(opts.agent) }
  if (opts.from) { conditions.push('timestamp >= ?'); params.push(opts.from) }
  if (opts.to) { conditions.push('timestamp <= ?'); params.push(opts.to) }
  if (opts.minTokens) {
    conditions.push('(input_tokens + cache_read_tokens + cache_creation_tokens) >= ?')
    params.push(opts.minTokens)
  }
  if (opts.q) {
    const like = `%${opts.q}%`
    conditions.push('(agent LIKE ? OR tool_name LIKE ? OR content_preview LIKE ? OR task_title LIKE ?)')
    params.push(like, like, like, like)
  }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' ORDER BY timestamp DESC'
  sql += ' LIMIT ? OFFSET ?'
  params.push(opts.limit || 100, opts.offset || 0)

  return db.prepare(sql).all(...params) as TokenDetail[]
}

export function correlateWithKanban(): void {
  const db = getDb()
  const noaDb = getNoaDb()
  const uncorrelated = db.prepare(`
    SELECT DISTINCT agent, MIN(timestamp) as minTs, MAX(timestamp) as maxTs
    FROM token_usage
    WHERE task_title IS NULL
    GROUP BY agent
  `).all() as { agent: string; minTs: number; maxTs: number }[]

  for (const row of uncorrelated) {
    const cards = noaDb.prepare(`
      SELECT id, title, project, assignee, updated_at
      FROM kanban_cards
      WHERE (assignee = ? OR assignee LIKE '%' || ? || '%')
        AND updated_at BETWEEN ? AND ?
      ORDER BY updated_at ASC
    `).all(row.agent, row.agent, row.minTs, row.maxTs) as any[]

    for (const card of cards) {
      const nextCard = cards.find((c: any) => c.updated_at > card.updated_at)
      const endTs = nextCard ? nextCard.updated_at : row.maxTs

      db.prepare(`
        UPDATE token_usage
        SET task_title = ?, project = ?
        WHERE agent = ? AND timestamp BETWEEN ? AND ? AND task_title IS NULL
      `).run(card.title, card.project || null, row.agent, card.updated_at, endTs)
    }
  }
}
