import Database from 'better-sqlite3'
import * as crypto from 'crypto'
import { join } from 'path'
import { logger } from './logger.js'
import { STORE_DIR } from './config.js'

// --- Environment ---
const NOA_DB_PATH = process.env.NOA_DB_PATH ?? join(STORE_DIR, 'noa.db')
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

// --- Access scope post-SQL filter (AC-4d) ---
function applyScopeFilter<T extends { access_scope: string | null }>(
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

// --- DB connection factory (AC-13) ---
let _db: Database.Database | null = null

export function initNoaDb(path: string): void {
  if (_db) _db.close()
  _db = openNoaDb(path)
}

function openNoaDb(path: string): Database.Database {
  const db = new Database(path)
  // AC-13: 5 pragmas applied in order
  // journal_mode = WAL requires a file-backed DB; :memory: returns 'memory' (expected in tests)
  const jm = (db.pragma('journal_mode = WAL') as Array<{ journal_mode: string }>)[0]?.journal_mode
  if (path !== ':memory:' && jm !== 'wal') {
    throw new Error(`journal_mode expected 'wal', got '${jm}'`)
  }
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('wal_autocheckpoint = 1000')
  return db
}

export function getNoaDb(): Database.Database {
  if (!_db) _db = openNoaDb(NOA_DB_PATH)
  return _db
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
