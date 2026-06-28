import Database from 'better-sqlite3'
import * as crypto from 'crypto'
import { logger } from './logger.js'
import { getNoaDb, initNoaDb } from './noa-db.js'

// Re-export so existing callers (tests, web/) can keep their current import path.
export { getNoaDb, initNoaDb }

// --- Environment ---
const OLLAMA_URL_RAW = process.env.OLLAMA_URL ?? 'http://localhost:11434'
export const EMBED_MODEL = process.env.EMBED_MODEL ?? 'nomic-embed-text'

export const HOT_TTL_DAYS    = Number(process.env.HOT_TTL_DAYS    ?? '2')
export const WARM_TTL_DAYS   = Number(process.env.WARM_TTL_DAYS   ?? '45')
export const HOT_SWEEP_BATCH  = Number(process.env.HOT_SWEEP_BATCH  ?? '1000')
export const WARM_SWEEP_BATCH = Number(process.env.WARM_SWEEP_BATCH ?? '1000')

// --- OLLAMA_URL validation (I1 HIGH -- must be localhost only at module init) ---
export function validateOllamaUrl(url: string): void {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    throw new Error(`OLLAMA_URL "${url}" is not a valid URL`)
  }
  // Node.js may return '::1' or '[::1]' for IPv6 loopback depending on version
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1' && hostname !== '[::1]') {
    throw new Error(
      `OLLAMA_URL "${url}" must resolve to localhost/127.0.0.1/::1 (I1 PII guard); non-localhost causes startup failure`
    )
  }
}

// Hard-restrict at module init -- startup failure if non-localhost (no silent fallback)
try {
  validateOllamaUrl(OLLAMA_URL_RAW)
} catch (err) {
  logger.error({ err, url: OLLAMA_URL_RAW }, 'OLLAMA_URL must be localhost; refusing to start with non-local embedding endpoint')
  process.exit(1)
}
const OLLAMA_URL = OLLAMA_URL_RAW

// --- Category validation ---
const VALID_CATEGORIES = new Set(['hot', 'warm', 'cold', 'shared'])

export class InvalidCategoryError extends Error {
  constructor(category: string) {
    super(`Invalid memory category: "${category}". Must be one of: hot, warm, cold, shared`)
    this.name = 'InvalidCategoryError'
  }
}

export class ScopedSharedError extends Error {
  constructor() {
    super('scoped+shared is contradictory: a shared memory cannot also be access_scope-restricted')
    this.name = 'ScopedSharedError'
  }
}

// --- Curator allowlist (AC-8 -- code constant, never a caller-supplied parameter) ---
const CURATOR_AGENTS = new Set(['applegate'])

// --- PII detection (AC-5, ported from src/db.ts) ---
const PII_KEYWORDS = [
  // Health
  'egészség', 'health', 'orvos', 'doctor', 'betegség', 'illness',
  'gyógyszer', 'medication', 'diagnózis', 'diagnosis',
  // Calendar / personal
  'home address', 'lakcím', 'születésnap', 'birthday', 'személyes', 'personal schedule',
  // Address
  'cím', 'address', 'irányítószám', 'zip', 'postal',
  // Financial (Chad MED-1)
  'bank', 'bankszámla', 'hitelkártya', 'credit card', 'fizetés', 'iban', 'számlaszám',
  // Hungarian national identifiers (Chad MED-1)
  'taj', 'személyi', 'adóazonosító', 'adószám',
]

function deaccent(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
}

export function isPotentialPII(keywords: string | null | undefined, content: string): boolean {
  const hay = deaccent(`${keywords ?? ''}\n${content}`)
  return PII_KEYWORDS.some((kw) => hay.includes(deaccent(kw)))
}

// --- Access scope resolution (AC-5 + AC-6) ---
export function resolveAccessScope(
  agentId: string,
  category: string,
  keywords: string | undefined,
  content: string,
  accessScope: string | null | undefined,
): string | null {
  let effective: string | null
  if (accessScope === undefined) {
    effective = isPotentialPII(keywords, content) ? agentId : null
  } else if (accessScope === null || accessScope === '') {
    effective = null
  } else {
    effective = accessScope
  }
  if (category === 'shared' && effective !== null) throw new ScopedSharedError()
  return effective
}

// --- Access scope post-SQL filter (AC-4d) -- exported for route-wiring (W0a) ---
export function applyScopeFilter<T extends { access_scope: string | null }>(
  memories: T[],
  agentId: string | null,
): T[] {
  if (!agentId) return memories
  return memories.filter((m) => !m.access_scope || m.access_scope === agentId)
}

// --- FTS5 query builder (ported from src/db.ts) ---
function buildFtsMatchExpression(query: string): string {
  const MAX_TOKENS = 20
  const MAX_TOKEN_LEN = 64
  const sanitized = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
  if (!sanitized) return ''
  const tokens = sanitized
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS)
    .map((t) => t.slice(0, MAX_TOKEN_LEN) + '*')
  return tokens.join(' ')
}

// --- Types ---
export interface NoaMemory {
  id: number
  agent_id: string
  category: string
  content: string
  keywords: string | null
  topic_key: string | null
  access_scope: string | null
  embedding: Buffer | null
  created_at: number
  accessed_at: number
}

export interface DailyLogEntry {
  id: number
  agent_id: string
  date: string
  content: string
  created_at: number
}

// --- Embedding buffer helpers ---
function bufferToFloat32Array(buf: Buffer): Float32Array {
  const vec = new Float32Array(buf.byteLength / 4)
  for (let i = 0; i < vec.length; i++) {
    vec[i] = buf.readFloatLE(i * 4)
  }
  return vec
}

function float32ArrayToBuffer(vec: Float32Array): Buffer {
  // AC-7c: explicit writeFloatLE loop (Buffer.from(new Float32Array(vec).buffer) is FORBIDDEN)
  const buf = Buffer.allocUnsafe(vec.length * 4)
  vec.forEach((v, i) => buf.writeFloatLE(v, i * 4))
  return buf
}

// --- Embedding workflow (AC-7) ---
export async function getEmbedding(text: string): Promise<Float32Array | null> {
  const hash = crypto.createHash('sha256').update(text).digest('hex')
  const db = getNoaDb()

  // AC-7a: cache lookup
  const cached = db.prepare(
    'SELECT embedding FROM embedding_cache WHERE content_hash = ? AND model = ?'
  ).get(hash, EMBED_MODEL) as { embedding: Buffer } | undefined

  if (cached) return bufferToFloat32Array(cached.embedding)

  // AC-7b: Ollama call with 5s timeout (AC-7e: try-catch wraps both HTTP + DB write)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 2000) }),
      signal: controller.signal,
      redirect: 'error',  // I1 reinforcement: a 302 to a remote host must not silently bypass the localhost guard
    })
    const data = await resp.json() as { embedding?: number[] }
    if (!data.embedding) return null

    // AC-7c: explicit writeFloatLE (not Buffer.from(new Float32Array(vec).buffer))
    const buf = Buffer.allocUnsafe(data.embedding.length * 4)
    data.embedding.forEach((v, i) => buf.writeFloatLE(v, i * 4))

    // AC-7c: write to cache + return
    db.prepare(
      'INSERT OR REPLACE INTO embedding_cache (content_hash, model, embedding, created_at) VALUES (?, ?, ?, unixepoch())'
    ).run(hash, EMBED_MODEL, buf)

    return bufferToFloat32Array(buf)
  } catch (err) {
    logger.warn({ err }, 'Embedding generation failed (Ollama unavailable?)')
    return null
  } finally {
    clearTimeout(timeout)
  }
}

// AC-7d + AC-7e: fire-and-forget kick-off; outer try-catch ensures no unhandled rejection
function kickOffEmbedding(text: string, memoryId: number): void {
  void (async () => {
    try {
      const emb = await getEmbedding(text)
      if (emb) {
        getNoaDb().prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(float32ArrayToBuffer(emb), memoryId)
      }
    } catch (err) {
      logger.warn({ err }, `Embedding kick-off failed for memory ${memoryId}`)
    }
  })()
}

// --- sqlite-vec availability check (AC-4 -- SELECT vec_version(), NOT sqlite_version()) ---
function isSqliteVecLoaded(db: Database.Database): boolean {
  try {
    db.prepare('SELECT vec_version()').get()
    return true
  } catch {
    return false
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// --- Write path (AC-3) ---
export function saveMemory(
  agentId: string,
  content: string,
  category: 'hot' | 'warm' | 'cold' | 'shared',
  keywords?: string,
  accessScope?: string | null,
): { id: number } {
  if (!VALID_CATEGORIES.has(category)) throw new InvalidCategoryError(category)
  const scope = resolveAccessScope(agentId, category, keywords, content, accessScope)
  const now = Math.floor(Date.now() / 1000)
  const info = getNoaDb().prepare(
    'INSERT INTO memories (agent_id, category, content, keywords, topic_key, access_scope, created_at, accessed_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)'
  ).run(agentId, category, content, keywords ?? null, scope, now, now)
  const id = Number(info.lastInsertRowid)
  kickOffEmbedding(content + (keywords ? ' ' + keywords : ''), id)
  return { id }
}

// --- Read path: hybrid FTS5 + vector rerank (AC-4) ---
export async function searchMemories(
  agentId: string,
  query: string,
  limit: number = 10,
): Promise<NoaMemory[]> {
  const db = getNoaDb()
  const isCurator = CURATOR_AGENTS.has(agentId)
  const terms = buildFtsMatchExpression(query)
  if (!terms) return []

  let candidates: NoaMemory[]
  let fromLikeFallback = false

  // Step 1: FTS5 candidates (up to limit*3 for rerank headroom)
  try {
    candidates = isCurator
      ? db.prepare(
          `SELECT m.* FROM memories m JOIN memories_fts f ON m.id = f.rowid
           WHERE f.memories_fts MATCH ? ORDER BY rank LIMIT ?`
        ).all(terms, limit * 3) as NoaMemory[]
      : db.prepare(
          `SELECT m.* FROM memories m JOIN memories_fts f ON m.id = f.rowid
           WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared')
           ORDER BY rank LIMIT ?`
        ).all(terms, agentId, limit * 3) as NoaMemory[]
  } catch {
    // AC-4c: FTS5 MATCH threw (malformed query) -- fall back to LIKE scan, ORDER BY accessed_at DESC
    fromLikeFallback = true
    candidates = isCurator
      ? db.prepare(
          'SELECT * FROM memories WHERE (content LIKE ? OR keywords LIKE ?) ORDER BY accessed_at DESC LIMIT ?'
        ).all(`%${query}%`, `%${query}%`, limit * 3) as NoaMemory[]
      : db.prepare(
          "SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? OR keywords LIKE ?) ORDER BY accessed_at DESC LIMIT ?"
        ).all(agentId, `%${query}%`, `%${query}%`, limit * 3) as NoaMemory[]
  }

  // Step 2: vector rerank -- strict if/else; threshold = limit in BOTH branches (AC-4 C4)
  const withEmbedding = candidates.filter(c => c.embedding != null).length
  if (!fromLikeFallback && isSqliteVecLoaded(db) && withEmbedding >= limit) {
    const queryEmb = await getEmbedding(query)
    if (queryEmb) {
      const scored = candidates
        .filter(c => c.embedding != null)
        .map(c => ({
          mem: c,
          score: cosineSimilarity(queryEmb, bufferToFloat32Array(c.embedding!)),
        }))
      scored.sort((a, b) => b.score - a.score)
      const reranked = scored.slice(0, limit).map(s => s.mem)
      return isCurator ? reranked : applyScopeFilter(reranked, agentId)
    }
  }

  // Step 3: FTS5-only (or LIKE fallback) -- no rerank
  const result = candidates.slice(0, limit)
  return isCurator ? result : applyScopeFilter(result, agentId)
}

// --- Tier demotion sweep (AC-2) ---
export function runTierDemotionSweep(): { hotToWarm: number; warmToCold: number } {
  const db = getNoaDb()
  const now = Math.floor(Date.now() / 1000)
  const hotThreshold  = now - HOT_TTL_DAYS  * 86400
  const warmThreshold = now - WARM_TTL_DAYS * 86400

  // AC-2d: one-level-per-sweep -- run warm->cold FIRST so a hot-with-old-ts memory
  // only moves hot->warm in this pass (next sweep promotes it warm->cold).
  let warmToCold = 0, changed: number
  do {
    changed = db.prepare(
      "UPDATE memories SET category = 'cold' WHERE id IN (SELECT id FROM memories WHERE category = 'warm' AND accessed_at < ? LIMIT ?)"
    ).run(warmThreshold, WARM_SWEEP_BATCH).changes
    warmToCold += changed
  } while (changed > 0)

  // AC-2a: hot -> warm; shared is never touched
  let hotToWarm = 0
  do {
    changed = db.prepare(
      "UPDATE memories SET category = 'warm' WHERE id IN (SELECT id FROM memories WHERE category = 'hot' AND accessed_at < ? LIMIT ?)"
    ).run(hotThreshold, HOT_SWEEP_BATCH).changes
    hotToWarm += changed
  } while (changed > 0)

  return { hotToWarm, warmToCold }
}

// --- touchMemory (AC-10) ---
export function touchMemory(id: number): void {
  getNoaDb().prepare('UPDATE memories SET accessed_at = unixepoch() WHERE id = ?').run(id)
}

// --- getMemories (AC-10) ---
export function getMemories(agentId: string, limit: number = 20, cursor?: number): NoaMemory[] {
  const db = getNoaDb()
  const isCurator = CURATOR_AGENTS.has(agentId)
  let rows: NoaMemory[]

  if (isCurator) {
    rows = cursor != null
      ? db.prepare('SELECT * FROM memories WHERE accessed_at < ? ORDER BY accessed_at DESC LIMIT ?').all(cursor, limit) as NoaMemory[]
      : db.prepare('SELECT * FROM memories ORDER BY accessed_at DESC LIMIT ?').all(limit) as NoaMemory[]
  } else {
    rows = cursor != null
      ? db.prepare("SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND accessed_at < ? ORDER BY accessed_at DESC LIMIT ?").all(agentId, cursor, limit) as NoaMemory[]
      : db.prepare("SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') ORDER BY accessed_at DESC LIMIT ?").all(agentId, limit) as NoaMemory[]
  }

  return isCurator ? rows : applyScopeFilter(rows, agentId)
}

// --- deleteMemory (AC-11) ---
export function deleteMemory(id: number, agentId: string): boolean {
  const isCurator = CURATOR_AGENTS.has(agentId)
  const info = isCurator
    ? getNoaDb().prepare('DELETE FROM memories WHERE id = ?').run(id)
    : getNoaDb().prepare('DELETE FROM memories WHERE id = ? AND agent_id = ?').run(id, agentId)
  return info.changes === 1
}

// --- Memory stats (AC-12) ---
export function getMemoryStats(): {
  total: number
  byAgent: Record<string, number>
  byTier: Record<string, number>
  withEmbedding: number
} {
  const db = getNoaDb()
  const run = db.transaction(() => ({
    total: (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c,
    withEmbedding: (db.prepare('SELECT COUNT(*) as c FROM memories WHERE embedding IS NOT NULL').get() as { c: number }).c,
    byAgentRows: db.prepare('SELECT agent_id, COUNT(*) as c FROM memories GROUP BY agent_id').all() as { agent_id: string; c: number }[],
    byTierRows:  db.prepare('SELECT category, COUNT(*) as c FROM memories GROUP BY category').all()  as { category: string;  c: number }[],
  }))
  const { total, withEmbedding, byAgentRows, byTierRows } = run()
  const byAgent: Record<string, number> = {}
  for (const r of byAgentRows) byAgent[r.agent_id] = r.c
  const byTier: Record<string, number> = {}
  for (const r of byTierRows) byTier[r.category] = r.c
  return { total, byAgent, byTier, withEmbedding }
}

// --- Daily log (AC-9) ---
export function appendDailyLog(agentId: string, content: string): void {
  const now = Math.floor(Date.now() / 1000)
  const date = new Date().toISOString().slice(0, 10)
  getNoaDb().prepare(
    'INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)'
  ).run(agentId, date, content, now)
}

export function getDailyLog(agentId: string, since: number): DailyLogEntry[] {
  return getNoaDb().prepare(
    'SELECT * FROM daily_logs WHERE agent_id = ? AND created_at >= ? ORDER BY created_at ASC'
  ).all(agentId, since) as DailyLogEntry[]
}

// ============================================================================
// W0a: Route-wiring adapters (additive exports for routes to switch off db.ts)
// ============================================================================

// saveAgentMemory: legacy-compatible signature (autoGenerated silently dropped --
// slim schema has no auto_generated column).
export function saveAgentMemory(
  agentId: string,
  content: string,
  category: string,
  keywords?: string,
  autoGenerated?: boolean,
  accessScope?: string | null,
): { id: number } {
  void autoGenerated  // slim schema: no auto_generated column
  return saveMemory(
    agentId,
    content,
    category as 'hot' | 'warm' | 'cold' | 'shared',
    keywords,
    accessScope,
  )
}

// getAgentMemories: legacy-compatible signature with optional curator bypass.
// curator=true is only honoured when agentId is in CURATOR_AGENTS (same invariant as legacy).
export function getAgentMemories(agentId: string, limit: number = 20, curator: boolean = false): NoaMemory[] {
  const db = getNoaDb()
  const bypass = curator && CURATOR_AGENTS.has(agentId)
  let rows: NoaMemory[]
  if (bypass) {
    rows = db.prepare('SELECT * FROM memories ORDER BY accessed_at DESC LIMIT ?').all(limit) as NoaMemory[]
    return rows
  }
  rows = db.prepare(
    "SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') ORDER BY accessed_at DESC LIMIT ?"
  ).all(agentId, limit) as NoaMemory[]
  return applyScopeFilter(rows, agentId)
}

// searchAgentMemories: sync FTS5-only search (no vector rerank; hybridSearch is the async path).
// curator=true only honoured for CURATOR_AGENTS members.
export function searchAgentMemories(
  agentId: string,
  query: string,
  limit: number = 10,
  curator: boolean = false,
): NoaMemory[] {
  const db = getNoaDb()
  const bypass = curator && CURATOR_AGENTS.has(agentId)
  const terms = buildFtsMatchExpression(query)
  if (!terms) return []
  try {
    const rows = bypass
      ? db.prepare(
          'SELECT m.* FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ? ORDER BY rank LIMIT ?'
        ).all(terms, limit) as NoaMemory[]
      : db.prepare(
          "SELECT m.* FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared') ORDER BY rank LIMIT ?"
        ).all(terms, agentId, limit) as NoaMemory[]
    return bypass ? rows : applyScopeFilter(rows, agentId)
  } catch {
    const escaped = escapeLike(query)
    const pat = `%${escaped}%`
    const rows = bypass
      ? db.prepare("SELECT * FROM memories WHERE (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\') ORDER BY accessed_at DESC LIMIT ?").all(pat, pat, limit) as NoaMemory[]
      : db.prepare("SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\') ORDER BY accessed_at DESC LIMIT ?").all(agentId, pat, pat, limit) as NoaMemory[]
    return bypass ? rows : applyScopeFilter(rows, agentId)
  }
}

// updateMemory: full PUT replace -- bumps accessed_at.
export function updateMemory(
  id: number,
  content: string,
  category?: string,
  agentId?: string,
  keywords?: string,
): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['content = ?', 'accessed_at = ?']
  const params: unknown[] = [content, now]
  if (category) { sets.push('category = ?'); params.push(category) }
  if (agentId) { sets.push('agent_id = ?'); params.push(agentId) }
  if (keywords !== undefined) { sets.push('keywords = ?'); params.push(keywords) }
  params.push(id)
  return getNoaDb().prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
}

// MemoryPatch + patchMemory: partial update, does NOT bump accessed_at (curation edit semantics).
export interface MemoryPatch {
  content?: string
  category?: string
  keywords?: string | null
  agentId?: string
}

export function patchMemory(id: number, patch: MemoryPatch): string[] {
  const sets: string[] = []
  const cols: string[] = []
  const params: unknown[] = []
  if (patch.content !== undefined) { sets.push('content = ?'); cols.push('content'); params.push(patch.content) }
  if (patch.category !== undefined) { sets.push('category = ?'); cols.push('category'); params.push(patch.category) }
  if (patch.keywords !== undefined) { sets.push('keywords = ?'); cols.push('keywords'); params.push(patch.keywords) }
  if (patch.agentId !== undefined) { sets.push('agent_id = ?'); cols.push('agent_id'); params.push(patch.agentId) }
  if (sets.length === 0) return []
  params.push(id)
  const changes = getNoaDb().prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes
  if (changes === 0) return []
  if (patch.content !== undefined) {
    const row = getNoaDb().prepare('SELECT keywords FROM memories WHERE id = ?').get(id) as { keywords: string | null } | undefined
    const kw = patch.keywords !== undefined ? patch.keywords : row?.keywords
    const text = patch.content + (kw ? ' ' + kw : '')
    void (async () => {
      try {
        const emb = await getEmbedding(text)
        if (emb) getNoaDb().prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(float32ArrayToBuffer(emb), id)
      } catch { /* best-effort */ }
    })()
  }
  return cols
}

// hybridSearch: RRF fusion of FTS5 + cosine vector rerank (async).
export async function hybridSearch(agentId: string, query: string, limit = 10): Promise<NoaMemory[]> {
  const k = 60
  const db = getNoaDb()
  const bypass = CURATOR_AGENTS.has(agentId)

  const ftsResults = searchAgentMemories(agentId, query, limit * 2, bypass)

  const queryEmb = await getEmbedding(query)
  const candidates: NoaMemory[] = bypass
    ? db.prepare('SELECT * FROM memories WHERE embedding IS NOT NULL').all() as NoaMemory[]
    : db.prepare("SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND embedding IS NOT NULL").all(agentId) as NoaMemory[]
  const vecResults: NoaMemory[] = queryEmb
    ? candidates
        .map(m => ({ m, score: cosineSimilarity(queryEmb, bufferToFloat32Array(m.embedding!)) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit * 2)
        .map(x => x.m)
    : []

  const scores = new Map<number, number>()
  const byId = new Map<number, NoaMemory>()
  ftsResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + rank + 1))
    byId.set(m.id, m)
  })
  vecResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) ?? 0) + 1 / (k + rank + 1))
    byId.set(m.id, m)
  })

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1])
  const result = ranked.slice(0, limit).map(([id]) => byId.get(id)!)
  return bypass ? result : applyScopeFilter(result, agentId)
}

// BackfillResult + backfillEmbeddings: sequential backfill for NULL-embedding memories.
export interface BackfillResult {
  total: number
  succeeded: number
  failed: number
  aborted: boolean
}

export async function backfillEmbeddings(
  opts: {
    embed?: (text: string) => Promise<number[] | null>
    onProgress?: (done: number, total: number, succeeded: number) => void
  } = {},
): Promise<BackfillResult> {
  const db = getNoaDb()
  const rows = db.prepare(
    'SELECT id, content, keywords FROM memories WHERE embedding IS NULL'
  ).all() as { id: number; content: string; keywords: string | null }[]
  const total = rows.length
  const update = db.prepare('UPDATE memories SET embedding = ? WHERE id = ?')

  let succeeded = 0, failed = 0, consecutiveFail = 0, aborted = false

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const text = row.content + (row.keywords ? ' ' + row.keywords : '')
    let emb: number[] | null = null
    try {
      if (opts.embed) {
        emb = await opts.embed(text)
      } else {
        const fa = await getEmbedding(text)
        emb = fa ? Array.from(fa) : null
      }
    } catch { emb = null }

    if (emb && emb.length > 0) {
      const buf = Buffer.allocUnsafe(emb.length * 4)
      emb.forEach((v, i) => buf.writeFloatLE(v, i * 4))
      update.run(buf, row.id)
      succeeded++
      consecutiveFail = 0
    } else {
      failed++
      consecutiveFail++
      if (consecutiveFail >= 3) {
        logger.warn({ total, succeeded, failed }, 'backfillEmbeddings: 3 consecutive empty embeddings -- embedder unreachable, aborting')
        aborted = true
        break
      }
    }
    opts.onProgress?.(i + 1, total, succeeded)
  }

  return { total, succeeded, failed, aborted }
}

// getDailyLogDates: list distinct dates from daily_logs DESC.
export function getDailyLogDates(agentId: string, limit: number = 14): string[] {
  return (getNoaDb().prepare(
    'SELECT DISTINCT date FROM daily_logs WHERE agent_id = ? ORDER BY date DESC LIMIT ?'
  ).all(agentId, limit) as { date: string }[]).map(r => r.date)
}

// RecallResult type (mirrors src/db.ts for W1 route-wiring).
export interface RecallResult {
  logs: { id: number; agent_id: string; date: string; content: string; created_at: number }[]
  memories: NoaMemory[]
  dateRange: { from: string; to: string }
}

// toBudapestTs: convert a YYYY-MM-DD date string to a Unix timestamp in Budapest local time.
function toBudapestTs(dateStr: string, endOfDay: boolean): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Budapest',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const refDate = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}`)
  const parts = fmt.formatToParts(refDate)
  const get = (t: string) => parts.find(p => p.type === t)?.value || '0'
  const localStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
  const localMs = new Date(localStr + 'Z').getTime()
  const offsetMs = localMs - refDate.getTime()
  const target = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}Z`)
  return Math.floor((target.getTime() - offsetMs) / 1000)
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

// recallByDateRange: retrieve logs + memories for a Budapest-local date range.
export function recallByDateRange(from: string, to: string, agentId?: string): RecallResult {
  const db = getNoaDb()
  const logSql = agentId
    ? 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? AND agent_id = ? ORDER BY date ASC, created_at ASC'
    : 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? ORDER BY date ASC, created_at ASC'
  const logParams = agentId ? [from, to, agentId] : [from, to]
  const logs = db.prepare(logSql).all(...logParams) as RecallResult['logs']

  const fromTs = toBudapestTs(from, false)
  const toTs = toBudapestTs(to, true)
  const memSql = agentId
    ? "SELECT * FROM memories WHERE created_at >= ? AND created_at <= ? AND (agent_id = ? OR category = 'shared') ORDER BY created_at ASC"
    : 'SELECT * FROM memories WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC'
  const memParams = agentId ? [fromTs, toTs, agentId] : [fromTs, toTs]
  const memories = db.prepare(memSql).all(...memParams) as NoaMemory[]

  return { logs, memories: applyScopeFilter(memories, agentId ?? null), dateRange: { from, to } }
}

// recallSearch: FTS5 + LIKE search over memories + daily logs.
export function recallSearch(query: string, agentId?: string, limit = 50): RecallResult {
  const db = getNoaDb()
  const terms = buildFtsMatchExpression(query)
  let memories: NoaMemory[] = []
  const escaped = escapeLike(query)

  if (terms) {
    try {
      const sql = agentId
        ? `SELECT m.* FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared') ORDER BY m.created_at DESC LIMIT ?`
        : `SELECT m.* FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ? ORDER BY m.created_at DESC LIMIT ?`
      memories = agentId
        ? db.prepare(sql).all(terms, agentId, limit) as NoaMemory[]
        : db.prepare(sql).all(terms, limit) as NoaMemory[]
    } catch {
      const sql = agentId
        ? "SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?"
        : "SELECT * FROM memories WHERE (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?"
      const pat = `%${escaped}%`
      memories = agentId
        ? db.prepare(sql).all(agentId, pat, pat, limit) as NoaMemory[]
        : db.prepare(sql).all(pat, pat, limit) as NoaMemory[]
    }
  }

  const logSql = agentId
    ? "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' AND agent_id = ? ORDER BY date DESC, created_at DESC LIMIT ?"
    : "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' ORDER BY date DESC, created_at DESC LIMIT ?"
  const logPat = `%${escaped}%`
  const logs = agentId
    ? db.prepare(logSql).all(logPat, agentId, limit) as RecallResult['logs']
    : db.prepare(logSql).all(logPat, limit) as RecallResult['logs']

  const dates = logs.map(l => l.date)
  const from = dates.length ? dates[dates.length - 1] : ''
  const to = dates.length ? dates[0] : ''

  return { logs, memories: applyScopeFilter(memories, agentId ?? null), dateRange: { from, to } }
}
