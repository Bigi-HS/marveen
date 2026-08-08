import {
  saveAgentMemory, getAgentMemories, searchAgentMemories, getMemoryStats, updateMemory,
  patchMemory, type MemoryPatch,
  hybridSearch, backfillEmbeddings,
  searchAgentMemories as searchMemoriesGlobal, applyScopeFilter, ScopedSharedError,
  deleteMemory, getNoaDb, type NoaMemory,
} from '../../noa-memory.js'
import { MAIN_AGENT_ID, OLLAMA_URL } from '../../config.js'
import { logger } from '../../logger.js'
import { decideMemoryMutation, enforceFromBindingEnabled } from '../agent-identity-binding.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Resolve a memory row's owner (single owner per row -- the `agent_id` column).
// Returns undefined when the id does not exist, so the caller can 404 cleanly
// before any authorization decision.
function memoryOwner(id: number): string | undefined {
  const row = getNoaDb().prepare('SELECT agent_id FROM memories WHERE id = ?').get(id) as { agent_id: string } | undefined
  return row?.agent_id
}

// Canonical memory categories. Kept in sync with the DB CHECK constraint in
// src/db.ts so the API rejects bad values before they even reach SQLite.
const MEMORY_CATEGORIES = new Set(['hot', 'warm', 'cold', 'shared'])

const SUSPICIOUS_PATTERNS = [
  /\bcurl\s+(-[a-zA-Z]\s+)*https?:\/\//i,
  /\bbash\s+-c\b/i,
  /\beval\s*\(/i,
  /\bexec\s*\(/i,
  /\bimport\s+subprocess\b/i,
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /override\s+your\s+(instructions|rules|safety|guidelines)/i,
  /forget\s+your\s+(instructions|rules|safety|guidelines|training)/i,
  /new\s+persona/i,
  /\brm\s+-rf\b/i,
]

function containsSuspiciousContent(content: string): boolean {
  return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(content))
}

export async function tryHandleMemories(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url, identity } = ctx

  if (path === '/api/memories' && method === 'POST') {
    const body = await readBody(req)
    // `access_scope` is read with `'access_scope' in data` semantics below so we
    // can tell "field absent" (=> PII auto-scope) from "explicit null" (opt-out).
    const data = JSON.parse(body.toString()) as { agent_id?: string; content: string; tier?: string; category?: string; keywords?: string; access_scope?: string | null }
    if (!data.content?.trim()) { json(res, { error: 'Content is required' }, 400); return true }
    if (containsSuspiciousContent(data.content)) {
      logger.warn({ agent: data.agent_id }, 'Memory content rejected: suspicious pattern')
      json(res, { error: 'Content rejected by security filter' }, 400)
      return true
    }
    if (data.tier && !data.category) {
      logger.warn({ agent: data.agent_id }, '[DEPRECATED] /api/memories: use "category" instead of "tier"')
    }
    const category = (data.category || data.tier || 'warm').toLowerCase()
    if (!MEMORY_CATEGORIES.has(category)) {
      json(res, { error: `Invalid category "${category}". Allowed: ${[...MEMORY_CATEGORIES].join(', ')}` }, 400)
      return true
    }
    // Distinguish absent (auto-scope) from explicit null (opt-out) from a value.
    const accessScope = 'access_scope' in data ? data.access_scope : undefined
    try {
      const result = saveAgentMemory(
        data.agent_id || MAIN_AGENT_ID,
        data.content.trim(),
        category,
        data.keywords || undefined,
        true,
        accessScope,
      )
      // Card MEM/8ad3a1c9: report the scope that was actually applied. Content-derived
      // scoping used to leave no trace here at all, so a caller could not tell an
      // unscoped write from one the classifier had quietly restricted to them.
      json(res, { ok: true, id: result.id, access_scope: result.access_scope })
    } catch (err) {
      if (err instanceof ScopedSharedError) {
        json(res, { error: err.message }, 400)
        return true
      }
      throw err
    }
    return true
  }

  // Read isolation is NOT a goal of the capability-token system (DA FLAG 2): the
  // per-agent scope set gates WRITE/DELETE (decideMemoryMutation) only. Reads here
  // are authentication-only -- any valid token can GET memories, filtered by the
  // advisory, caller-supplied ?agent= and access_scope, not by the token identity.
  // Closing read isolation is OS-user/broker work (design Option B/C), out of this
  // Tier-1 slice.
  if (path === '/api/memories' && method === 'GET') {
    const q = url.searchParams.get('q')?.trim() || ''
    const agentId = url.searchParams.get('agent') || ''
    const tier = url.searchParams.get('tier') || url.searchParams.get('category') || ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
    const mode = url.searchParams.get('mode') || 'fts'

    let results: NoaMemory[]
    if (q && mode === 'hybrid') {
      results = await hybridSearch(agentId || MAIN_AGENT_ID, q, limit)
    } else if (q && agentId) {
      results = searchAgentMemories(agentId, q, limit)
      if (results.length === 0) {
        const db2 = getNoaDb()
        results = db2.prepare("SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? OR keywords LIKE ?) ORDER BY accessed_at DESC LIMIT ?")
          .all(agentId, `%${q}%`, `%${q}%`, limit) as NoaMemory[]
      }
    } else if (q) {
      // q-only path: chat_id retired (W1); search as MAIN_AGENT_ID (includes shared).
      results = searchMemoriesGlobal(MAIN_AGENT_ID, q, limit)
      if (results.length === 0) {
        const db2 = getNoaDb()
        results = db2.prepare('SELECT * FROM memories WHERE content LIKE ? ORDER BY accessed_at DESC LIMIT ?').all(`%${q}%`, limit) as NoaMemory[]
      }
    } else if (agentId) {
      results = getAgentMemories(agentId, limit)
    } else {
      // no-agent, no-q: chat_id retired (W1); return recent memories for MAIN_AGENT_ID (includes shared).
      results = getAgentMemories(MAIN_AGENT_ID, limit)
    }

    // PM-AC3 single enforcement point (covers the q-only/neither leak paths and
    // the inline LIKE fallbacks above; idempotent for the db-layer-filtered
    // paths). requester = the advisory ?agent= identity; absent => operator/
    // admin context (PM-AC6: the dashboard/operator sees all, including scoped).
    // NOTE: ?agent= is caller-supplied and NOT authenticated -- advisory only.
    results = applyScopeFilter(results, agentId || null)

    if (tier) results = results.filter(m => m.category === tier)

    const formatted = results.map(m => ({
      ...m,
      embedding: undefined,
      created_label: new Date(m.created_at * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }),
      accessed_label: new Date(m.accessed_at * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' }),
    }))
    json(res, formatted)
    return true
  }

  if (path === '/api/memories/import' && method === 'POST') {
    const body = await readBody(req)
    const { agent_id, chunks } = JSON.parse(body.toString()) as { agent_id: string; chunks: string[] }

    if (!chunks || !Array.isArray(chunks) || chunks.length === 0) {
      json(res, { error: 'No chunks to import' }, 400)
      return true
    }

    const agentId = agent_id || MAIN_AGENT_ID
    const stats = { hot: 0, warm: 0, cold: 0, shared: 0 }
    let imported = 0

    let categorizeModel: string | null = null
    try {
      const ollamaModels = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
        .then(r => r.json())
        .then((d: any) => (d.models || []).filter((m: any) => !m.name.includes('embed')).map((m: any) => m.name))
        .catch(() => [] as string[])
      categorizeModel = ollamaModels.find((m: string) => m.includes('gemma4')) || ollamaModels[0] || null
    } catch {
      categorizeModel = null
    }

    if (categorizeModel) {
      logger.info({ model: categorizeModel }, 'Migráció: AI kategorizálás modell kiválasztva')
    } else {
      logger.info('Migráció: nincs elérhető Ollama modell, alapértelmezett warm besorolás')
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]

      if (!categorizeModel) {
        saveAgentMemory(agentId, chunk, 'warm', '', true)
        stats.warm++
        imported++
        continue
      }

      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 90000)

        const catResponse = await fetch(`${OLLAMA_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: categorizeModel,
            prompt: `Categorize this memory into exactly one tier and generate keywords.

Memory: "${chunk.slice(0, 500)}"

Tiers:
- hot: active tasks, pending decisions, things happening NOW
- warm: preferences, config, project context, stable knowledge
- cold: long-term lessons, historical decisions, archive
- shared: information relevant to multiple agents

Respond ONLY with JSON, nothing else:
{"tier": "warm", "keywords": "keyword1, keyword2, keyword3"}`,
            stream: false,
          }),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        const catData = await catResponse.json() as { response?: string }

        let tier = 'warm'
        let keywords = ''

        try {
          const jsonMatch = (catData.response || '').match(/\{[\s\S]*\}/)
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0])
            tier = ['hot', 'warm', 'cold', 'shared'].includes(parsed.tier) ? parsed.tier : 'warm'
            keywords = parsed.keywords || ''
          }
        } catch {
          // Default to warm if parsing fails
        }

        saveAgentMemory(agentId, chunk, tier, keywords, true)
        stats[tier as keyof typeof stats]++
        imported++

        if (i < chunks.length - 1) {
          await new Promise(r => setTimeout(r, 200))
        }
      } catch {
        saveAgentMemory(agentId, chunk, 'warm', '', true)
        stats.warm++
        imported++
      }
    }

    logger.info({ agentId, imported, stats }, 'Migráció befejezve')
    json(res, { ok: true, imported, stats })
    return true
  }

  if (path === '/api/memories/backfill' && method === 'POST') {
    try {
      const r = await backfillEmbeddings()
      // `count` kept for backward compat with the existing dashboard client.
      json(res, { ok: !r.aborted, count: r.succeeded, ...r })
    } catch (err) {
      logger.error({ err }, 'Backfill failed')
      json(res, { error: 'Backfill failed' }, 500)
    }
    return true
  }

  // POST /api/memories/reembed: targeted backfill with optional category filter.
  // Body: { categories?: string[] }  (undefined = default hot/warm/shared; [] = all)
  if (path === '/api/memories/reembed' && method === 'POST') {
    try {
      const raw = await readBody(req)
      const body = raw.length ? (JSON.parse(raw.toString()) as { categories?: string[] }) : {}
      const r = await backfillEmbeddings({ categories: body.categories })
      json(res, { ok: !r.aborted, count: r.succeeded, ...r })
    } catch (err) {
      logger.error({ err }, 'Reembed failed')
      json(res, { error: 'Reembed failed' }, 500)
    }
    return true
  }

  if (path === '/api/memories/stats' && method === 'GET') {
    json(res, getMemoryStats())
    return true
  }

  const memUpdateMatch = path.match(/^\/api\/memories\/(\d+)$/)
  if (memUpdateMatch && method === 'PUT') {
    const id = parseInt(memUpdateMatch[1], 10)
    const body = await readBody(req)
    const { content, category, tier, agent_id, keywords } = JSON.parse(body.toString()) as { content: string; category?: string; tier?: string; agent_id?: string; keywords?: string }
    // Gap (a), card b1ce5118: a memory may only be mutated by its owner (or the
    // curator/admin scope). Resolve the owner from the token-bound identity, not
    // a body field. Gated behind ENFORCE_FROM_BINDING (default OFF) so it is
    // inert until rollout; with the flag off decideMemoryMutation always allows,
    // preserving today's behaviour exactly.
    const owner = memoryOwner(id)
    if (owner === undefined) { json(res, { error: 'Memory not found' }, 404); return true }
    const authz = decideMemoryMutation(identity, owner, enforceFromBindingEnabled())
    if (!authz.ok) {
      logger.warn({ tokenAgent: identity.agentId, owner, id, op: 'PUT' }, 'Rejected memory mutation: not owner')
      json(res, { error: authz.error }, authz.status)
      return true
    }
    if (updateMemory(id, content, tier || category, agent_id, keywords)) { json(res, { ok: true }); return true }
    json(res, { error: 'Memory not found' }, 404)
    return true
  }

  // PATCH /api/memories/<id> -- partial update (card e163dbf7). Persists any
  // subset of the mutable fields and returns which ones changed. A category-only
  // PATCH still updates ONLY the category and leaves content/accessed_at intact
  // (the b68b9e71 TM-1/TM-3 staleness invariant), so vault-lint --apply is
  // unaffected; a content update -- previously dropped silently -- now lands.
  if (memUpdateMatch && method === 'PATCH') {
    const id = parseInt(memUpdateMatch[1], 10)
    const body = await readBody(req)
    const parsed = JSON.parse(body.toString()) as
      { content?: unknown; category?: unknown; tier?: unknown; keywords?: unknown; agent_id?: unknown }

    const patch: MemoryPatch = {}
    // `tier` is accepted as an alias for `category`, matching the PUT handler.
    const cat = parsed.category !== undefined ? parsed.category : parsed.tier
    if (cat !== undefined) {
      if (typeof cat !== 'string' || !MEMORY_CATEGORIES.has(cat)) {
        json(res, { error: `category must be one of: ${[...MEMORY_CATEGORIES].join(', ')}` }, 400)
        return true
      }
      patch.category = cat
    }
    if (parsed.content !== undefined) {
      if (typeof parsed.content !== 'string' || parsed.content.trim() === '') {
        json(res, { error: 'content must be a non-empty string' }, 400)
        return true
      }
      patch.content = parsed.content
    }
    if (parsed.keywords !== undefined) {
      if (parsed.keywords !== null && typeof parsed.keywords !== 'string') {
        json(res, { error: 'keywords must be a string or null' }, 400)
        return true
      }
      patch.keywords = parsed.keywords
    }
    if (parsed.agent_id !== undefined) {
      if (typeof parsed.agent_id !== 'string' || parsed.agent_id.trim() === '') {
        json(res, { error: 'agent_id must be a non-empty string' }, 400)
        return true
      }
      patch.agentId = parsed.agent_id
    }
    if (Object.keys(patch).length === 0) {
      json(res, { error: 'no mutable fields provided (content, category/tier, keywords, agent_id)' }, 400)
      return true
    }

    const owner = memoryOwner(id)
    if (owner === undefined) { json(res, { error: 'Memory not found' }, 404); return true }
    const authz = decideMemoryMutation(identity, owner, enforceFromBindingEnabled())
    if (!authz.ok) {
      logger.warn({ tokenAgent: identity.agentId, owner, id, op: 'PATCH' }, 'Rejected memory mutation: not owner')
      json(res, { error: authz.error }, authz.status)
      return true
    }
    const updated = patchMemory(id, patch)
    if (updated.length > 0) { json(res, { ok: true, updated }); return true }
    json(res, { error: 'Memory not found' }, 404)
    return true
  }

  if (memUpdateMatch && method === 'DELETE') {
    const id = parseInt(memUpdateMatch[1], 10)
    const owner = memoryOwner(id)
    if (owner === undefined) { json(res, { error: 'Memory not found' }, 404); return true }
    const authz = decideMemoryMutation(identity, owner, enforceFromBindingEnabled())
    if (!authz.ok) {
      logger.warn({ tokenAgent: identity.agentId, owner, id, op: 'DELETE' }, 'Rejected memory mutation: not owner')
      json(res, { error: authz.error }, authz.status)
      return true
    }
    const deleted = deleteMemory(id, owner)
    if (deleted) { json(res, { ok: true }); return true }
    json(res, { error: 'Memory not found' }, 404)
    return true
  }

  return false
}
