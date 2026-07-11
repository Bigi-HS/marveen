import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'
import {
  isCodetreeBuilt,
  getIndexedAtEpoch,
  getIndexMeta,
  getStoredSchemaVersion,
  querySymbolsByName,
  fileIndexed,
  queryExportsForFile,
  queryImporters,
  queryCallers,
  queryCallees,
  CODETREE_SCHEMA_VERSION,
} from '../codetree-db.js'
import type { RebuildSummary } from '../codetree-rebuild.js'
import { spawnRebuildWorker } from '../codetree-rebuild-spawn.js'
import { buildImpactReport, type ImpactDeps } from '../codetree-impact.js'
import { realImpactDeps } from '../codetree-impact-io.js'

const STALE_AFTER_SECONDS = 24 * 3600

// Card id allowed shape -- kanban ids are short hex, but guard the URL param so
// it can never carry a glob/`..` into the branch-ref scan.
const CARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

// Defense-in-depth: cap the optional `?agent=` param to a sane identifier shape
// even though it only feeds a parameterized DB query (so it is not injectable).
const AGENT_RE = /^[A-Za-z0-9_-]{1,64}$/

// Diff ref allowed shape: a single git revision OR an `a..b`/`a...b` range. Must
// NOT start with `-` -- although git runs via execFileSync argv (no shell), a
// leading-dash ref would be parsed as a git OPTION (e.g. `--output=<file>` =>
// arbitrary file write). Anchoring to an alphanumeric first char blocks that
// argument injection. A single refname segment must NOT itself contain `..`
// (only the range separator may): a refname is matched as alphanumerics plus a
// dot that is NOT immediately followed by another dot, so `..`/`...` is only
// ever the range operator between two clean refs (defense-in-depth, card 139b5434).
const DIFF_REF_NAME = '[A-Za-z0-9](?:\\.(?!\\.)|[A-Za-z0-9_/~^-])*'
const DIFF_REF_RE = new RegExp(`^${DIFF_REF_NAME}(?:\\.\\.\\.?${DIFF_REF_NAME})?$`)

// Injectable so route tests can stub all git/fs/DB IO (mirrors
// __setCodetreeRebuildRunner). Production builds the real deps.
let impactDepsBuilder: (opts: { agent?: string }) => ImpactDeps = realImpactDeps

export function __setImpactDepsBuilder(fn: (opts: { agent?: string }) => ImpactDeps): void {
  impactDepsBuilder = fn
}

// Rebuild is delegated to a runner so production spawns a child process while
// tests inject a deterministic stub. Module-scoped lock (single server process)
// enforces CT-AC6: one rebuild at a time.
let rebuildRunner: () => Promise<RebuildSummary> = spawnRebuildWorker
let rebuildInProgress: { started_at: string } | null = null

export function __setCodetreeRebuildRunner(fn: () => Promise<RebuildSummary>): void {
  rebuildRunner = fn
}

function indexedAtIso(): string {
  const epoch = getIndexedAtEpoch()
  return epoch != null ? new Date(epoch * 1000).toISOString() : ''
}

function isStale(): boolean {
  const epoch = getIndexedAtEpoch()
  if (epoch == null) return true
  // A schema older than the current one is stale regardless of age: the on-disk
  // index predates the current shape (e.g. no code_calls data), so consumers
  // must rebuild rather than trust a silently-empty graph (card 52815f7c).
  if (getStoredSchemaVersion() !== CODETREE_SCHEMA_VERSION) return true
  return Math.floor(Date.now() / 1000) - epoch > STALE_AFTER_SECONDS
}

// Read endpoints return 503 before the first rebuild rather than a misleading
// empty result (CT-AC4 / CT-SEC1 safety theme).
function notBuilt(res: RouteContext['res']): boolean {
  if (!isCodetreeBuilt()) {
    json(res, { error: 'codetree index has not been built; POST /api/codetree/rebuild' }, 503)
    return true
  }
  return false
}

export async function tryHandleCodetree(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/codetree/symbol' && method === 'GET') {
    const name = url.searchParams.get('name')
    if (!name) { json(res, { error: 'name parameter is required' }, 400); return true }
    if (notBuilt(res)) return true
    json(res, { indexed_at: indexedAtIso(), results: querySymbolsByName(name) })
    return true
  }

  if (path === '/api/codetree/exports' && method === 'GET') {
    const file = url.searchParams.get('file')
    if (!file) { json(res, { error: 'file parameter is required' }, 400); return true }
    if (notBuilt(res)) return true
    if (!fileIndexed(file)) { json(res, { error: 'file not indexed', file }, 404); return true }
    json(res, { indexed_at: indexedAtIso(), file, exports: queryExportsForFile(file) })
    return true
  }

  if (path === '/api/codetree/importers' && method === 'GET') {
    const moduleQuery = url.searchParams.get('module')
    if (!moduleQuery) { json(res, { error: 'module parameter is required' }, 400); return true }
    if (notBuilt(res)) return true
    json(res, { indexed_at: indexedAtIso(), module: moduleQuery, importers: queryImporters(moduleQuery) })
    return true
  }

  if (path === '/api/codetree/callers' && method === 'GET') {
    const name = url.searchParams.get('name')
    if (!name) { json(res, { error: 'name parameter is required' }, 400); return true }
    if (notBuilt(res)) return true
    json(res, { indexed_at: indexedAtIso(), name, callers: queryCallers(name) })
    return true
  }

  if (path === '/api/codetree/callees' && method === 'GET') {
    const symbol = url.searchParams.get('symbol')
    if (!symbol) { json(res, { error: 'symbol parameter is required' }, 400); return true }
    if (notBuilt(res)) return true
    const file = url.searchParams.get('file') ?? undefined
    json(res, { indexed_at: indexedAtIso(), symbol, callees: queryCallees(symbol, file) })
    return true
  }

  if (path === '/api/codetree/impact' && method === 'GET') {
    const diff = url.searchParams.get('diff')
    const card = url.searchParams.get('card')
    if (!diff && !card) { json(res, { error: 'diff or card parameter is required' }, 400); return true }
    if (diff && card) { json(res, { error: 'provide only one of diff or card' }, 400); return true }
    if (card && !CARD_ID_RE.test(card)) { json(res, { error: 'invalid card id' }, 400); return true }
    if (diff && !DIFF_REF_RE.test(diff)) { json(res, { error: 'invalid diff ref' }, 400); return true }
    const agent = url.searchParams.get('agent') ?? undefined
    if (agent !== undefined && !AGENT_RE.test(agent)) { json(res, { error: 'invalid agent' }, 400); return true }
    if (notBuilt(res)) return true
    try {
      const report = buildImpactReport(
        diff ? { kind: 'diff', ref: diff } : { kind: 'card', cardId: card! },
        impactDepsBuilder({ agent }),
      )
      json(res, report)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(res, { error: msg }, /unknown card/.test(msg) ? 404 : 500)
    }
    return true
  }

  if (path === '/api/codetree/meta' && method === 'GET') {
    const meta = getIndexMeta()
    if (meta == null) { json(res, { error: 'codetree index has not been built' }, 503); return true }
    json(res, {
      indexed_at: indexedAtIso(),
      files_count: meta.files_count,
      symbols_count: meta.symbols_count,
      imports_count: meta.imports_count,
      calls_count: meta.calls_count,
      schema_version: meta.schema_version,
      stale: isStale(),
    })
    return true
  }

  if (path === '/api/codetree/rebuild' && method === 'POST') {
    if (rebuildInProgress) {
      json(res, { error: 'rebuild in progress', started_at: rebuildInProgress.started_at }, 409)
      return true
    }
    rebuildInProgress = { started_at: new Date().toISOString() }
    try {
      const summary = await rebuildRunner()
      json(res, { status: 'ok', ...summary })
    } catch (err) {
      json(res, { error: 'rebuild failed', detail: err instanceof Error ? err.message : String(err) }, 500)
    } finally {
      rebuildInProgress = null
    }
    return true
  }

  return false
}
