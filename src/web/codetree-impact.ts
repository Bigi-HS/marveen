// Codetree context-motor (card 5428b78d) -- change-impact + spec-loader on top
// of the Phase-1 code knowledge graph (card 12c08ee2). This file holds the PURE
// core; the DB / git / HTTP wiring lives in the route + thin IO helpers so the
// blast-radius logic is testable without a database.

import type { SymbolRow } from './codetree-db.js'

export interface AffectedFile {
  file: string
  /** Hops from the nearest seed file. Seeds are depth 0, their direct importers 1, etc. */
  depth: number
}

export interface SpecHit {
  path: string
  /** Number of distinct card keywords found in the spec text. */
  score: number
}

// Stopwords dropped from card keyword extraction (small EN + HU operational set;
// the ranking is best-effort, so this only needs to strip the highest-frequency
// noise words, not be exhaustive).
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'over', 'card',
  'add', 'fix', 'use', 'via', 'per', 'not', 'are', 'was', 'has', 'its', 'new',
  'vagy', 'hogy', 'egy', 'ket', 'mar', 'nem', 'mit', 'csak', 'lesz', 'kell',
])

const MIN_TOKEN_LEN = 3

/**
 * Turn a card's title + description into lowercase search tokens: split on any
 * non-alphanumeric boundary, drop stopwords and tokens shorter than
 * {@link MIN_TOKEN_LEN}, dedupe while preserving first-seen order. The tokens
 * feed both the spec ranking and the symbol-name substring match.
 */
export function extractKeywords(title: string, desc: string): string[] {
  const tokens = `${title} ${desc}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t))
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

/**
 * Rank existing specs by how many distinct keywords appear in their text
 * (case-insensitive substring). Specs with no match are dropped; ties break by
 * path ascending so the ordering is deterministic.
 */
export function rankSpecs(keywords: string[], specs: Array<{ path: string; text: string }>): SpecHit[] {
  const lowered = keywords.map((k) => k.toLowerCase())
  const hits: SpecHit[] = []
  for (const spec of specs) {
    const text = spec.text.toLowerCase()
    let score = 0
    for (const kw of lowered) {
      if (text.includes(kw)) score++
    }
    if (score > 0) hits.push({ path: spec.path, score })
  }
  hits.sort((a, b) => (b.score - a.score) || a.path.localeCompare(b.path))
  return hits
}

/**
 * Select defined symbols whose name contains any card keyword (case-insensitive
 * substring; keywords shorter than {@link MIN_TOKEN_LEN} are ignored). Exported
 * symbols sort first -- they are the natural spec seams -- then by name.
 */
export function selectSymbolHits(keywords: string[], symbols: SymbolRow[]): SymbolRow[] {
  const lowered = keywords.filter((k) => k.length >= MIN_TOKEN_LEN).map((k) => k.toLowerCase())
  const hits = symbols.filter((s) => {
    const name = s.name.toLowerCase()
    return lowered.some((kw) => name.includes(kw))
  })
  hits.sort((a, b) => (Number(b.exported) - Number(a.exported)) || a.name.localeCompare(b.name))
  return hits
}

/**
 * Paths of specs whose text mentions the exact (case-sensitive) symbol name --
 * the "also-in-spec" cross-reference that seeds a spec's "what's already
 * specced" section. Symbol names are identifiers, so the match is exact, not
 * lowercased.
 */
export function specsMentioningSymbol(symbolName: string, specs: Array<{ path: string; text: string }>): string[] {
  return specs.filter((s) => s.text.includes(symbolName)).map((s) => s.path).sort()
}

// ---- orchestrator ----------------------------------------------------------

export interface MemoryHit {
  id: number
  content: string
  category: string
  keywords: string | null
}

export interface SymbolHit extends SymbolRow {
  /** Existing specs that mention this symbol -- seeds the "what's already specced" section. */
  also_in_spec: string[]
}

export interface ImpactReport {
  input: { kind: 'diff' | 'card'; ref?: string; card_id?: string; resolution?: 'branch-diff' | 'keyword' }
  seed_files: string[]
  affected: AffectedFile[]
  symbols: SymbolHit[]
  specs: SpecHit[]
  hot_memory: MemoryHit[]
  index: { indexed_at: number | null; stale: boolean }
}

export type ImpactInput =
  | { kind: 'diff'; ref: string }
  | { kind: 'card'; cardId: string }

// All IO is injected so the orchestration logic (mode detection, resolution,
// envelope assembly) is unit-testable without git / the DB / the filesystem.
export interface ImpactDeps {
  /** Direct importers of a file (codetree graph). */
  importersOf: (file: string) => string[]
  /** Every indexed symbol (for keyword substring matching). */
  allSymbols: () => SymbolRow[]
  /** The store/specs corpus as {path, text}. */
  specCorpus: () => Array<{ path: string; text: string }>
  /** Hot-tier memories matching the keywords. */
  searchHotMemory: (keywords: string[]) => MemoryHit[]
  /** Card title+description, or null if the id is unknown. */
  getCard: (id: string) => { title: string; description: string | null } | null
  /** Concrete changed files if a branch exists for the card, else null (pre-code). */
  getCardFiles: (id: string) => string[] | null
  /** Changed files for an explicit diff ref. */
  diffFiles: (ref: string) => string[]
  /** Current index freshness. */
  index: () => { indexed_at: number | null; stale: boolean }
  maxDepth?: number
  limits?: { specs?: number; symbols?: number; memory?: number }
}

const DEFAULT_LIMITS = { specs: 10, symbols: 20, memory: 10 }

// Derive search keywords from a set of file paths: basename without extension,
// then the same tokenisation as a card's title -- so diff/change-impact mode
// also surfaces relevant specs, symbols and memory.
function keywordsFromFiles(files: string[]): string[] {
  const blob = files.map((f) => f.replace(/^.*\//, '').replace(/\.[^.]+$/, '')).join(' ')
  return extractKeywords(blob, '')
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}

/**
 * Assemble the impact report for either a diff ref or a kanban card.
 *
 * - diff mode: seeds = the changed files.
 * - card mode: if a branch exists for the card, seeds = its diff (branch-diff
 *   resolution, precise -- the gate/TDD use); otherwise (pre-code) resolve by
 *   keyword over symbols/specs/memory (the spec-init use).
 *
 * In both modes the blast radius is the transitive importer closure of the
 * seeds, and specs/symbols/hot-memory are ranked against the derived keywords.
 */
export function buildImpactReport(input: ImpactInput, deps: ImpactDeps): ImpactReport {
  const limits = { ...DEFAULT_LIMITS, ...(deps.limits ?? {}) }
  const corpus = deps.specCorpus()

  let seedFiles: string[] = []
  let keywords: string[]
  const meta: ImpactReport['input'] = { kind: input.kind }

  if (input.kind === 'diff') {
    seedFiles = dedupe(deps.diffFiles(input.ref))
    keywords = keywordsFromFiles(seedFiles)
    meta.ref = input.ref
  } else {
    const card = deps.getCard(input.cardId)
    if (!card) throw new Error(`unknown card: ${input.cardId}`)
    meta.card_id = input.cardId
    keywords = extractKeywords(card.title, card.description ?? '')
  }

  // Symbol hits are derived once: they both seed the blast radius (keyword mode)
  // and form the symbol section of the report.
  const symbolHits = selectSymbolHits(keywords, deps.allSymbols())

  if (input.kind === 'card') {
    const branchFiles = deps.getCardFiles(input.cardId)
    if (branchFiles != null) {
      meta.resolution = 'branch-diff'
      seedFiles = dedupe(branchFiles)
    } else {
      meta.resolution = 'keyword'
      // pre-code: seed the blast radius from the files of keyword-matched symbols
      seedFiles = dedupe(symbolHits.map((s) => s.file))
    }
  }

  const affected = blastRadius(seedFiles, deps.importersOf, deps.maxDepth ?? Infinity)
  const specs = rankSpecs(keywords, corpus).slice(0, limits.specs)
  const symbols: SymbolHit[] = symbolHits
    .slice(0, limits.symbols)
    .map((s) => ({ ...s, also_in_spec: specsMentioningSymbol(s.name, corpus) }))
  const hot_memory = deps.searchHotMemory(keywords).slice(0, limits.memory)

  return { input: meta, seed_files: seedFiles, affected, symbols, specs, hot_memory, index: deps.index() }
}

/**
 * Transitive importer closure (the "blast radius" of a change). Breadth-first
 * from `seedFiles`: seeds are depth 0, each importer hop increments depth.
 *
 * - `importersOf(file)` returns the DIRECT importers of `file` (injected so the
 *   core is decoupled from the codetree DB).
 * - A file reachable via several paths keeps its MINIMUM depth -- BFS visits a
 *   node the first time at its shortest distance, and the visited set blocks
 *   re-entry, which also makes the walk cycle-safe.
 * - A seed that also imports another seed stays depth 0 (seeds are enqueued
 *   first); duplicate seeds are collapsed.
 * - `maxDepth` caps the walk (default unbounded); a node AT maxDepth is included
 *   but its importers are not expanded.
 */
export function blastRadius(
  seedFiles: string[],
  importersOf: (file: string) => string[],
  maxDepth = Infinity,
): AffectedFile[] {
  const visited = new Set<string>()
  const queue: AffectedFile[] = []

  for (const f of seedFiles) {
    if (!visited.has(f)) {
      visited.add(f)
      queue.push({ file: f, depth: 0 })
    }
  }

  for (let head = 0; head < queue.length; head++) {
    const { file, depth } = queue[head]
    if (depth >= maxDepth) continue
    for (const importer of importersOf(file)) {
      if (!visited.has(importer)) {
        visited.add(importer)
        queue.push({ file: importer, depth: depth + 1 })
      }
    }
  }

  return queue
}
