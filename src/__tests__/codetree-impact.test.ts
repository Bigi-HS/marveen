import { describe, it, expect } from 'vitest'
import {
  blastRadius,
  extractKeywords,
  rankSpecs,
  selectSymbolHits,
  specsMentioningSymbol,
  buildImpactReport,
  type ImpactDeps,
} from '../web/codetree-impact.js'

// `importersOf(file)` returns the DIRECT importers of `file`. The core is pure:
// the graph is injected as a plain adjacency map so blast-radius is testable
// without the codetree DB or the HTTP layer.
function graph(edges: Record<string, string[]>): (file: string) => string[] {
  return (file) => edges[file] ?? []
}

describe('blastRadius (transitive importer closure)', () => {
  it('returns empty for no seeds', () => {
    expect(blastRadius([], graph({}))).toEqual([])
  })

  it('returns the seed alone when nothing imports it', () => {
    expect(blastRadius(['src/a.ts'], graph({}))).toEqual([{ file: 'src/a.ts', depth: 0 }])
  })

  it('walks a linear importer chain with increasing depth', () => {
    // a is imported by b, b is imported by c
    const g = graph({ 'src/a.ts': ['src/b.ts'], 'src/b.ts': ['src/c.ts'] })
    expect(blastRadius(['src/a.ts'], g)).toEqual([
      { file: 'src/a.ts', depth: 0 },
      { file: 'src/b.ts', depth: 1 },
      { file: 'src/c.ts', depth: 2 },
    ])
  })

  it('keeps the MINIMUM depth for a file reachable via multiple paths (diamond)', () => {
    // a imported by b and c; both imported by d
    const g = graph({
      'src/a.ts': ['src/b.ts', 'src/c.ts'],
      'src/b.ts': ['src/d.ts'],
      'src/c.ts': ['src/d.ts'],
    })
    const out = blastRadius(['src/a.ts'], g)
    expect(out.find((x) => x.file === 'src/d.ts')).toEqual({ file: 'src/d.ts', depth: 2 })
    // d appears exactly once
    expect(out.filter((x) => x.file === 'src/d.ts')).toHaveLength(1)
  })

  it('is cycle-safe', () => {
    const g = graph({ 'src/a.ts': ['src/b.ts'], 'src/b.ts': ['src/a.ts'] })
    const out = blastRadius(['src/a.ts'], g)
    expect(out).toEqual([
      { file: 'src/a.ts', depth: 0 },
      { file: 'src/b.ts', depth: 1 },
    ])
  })

  it('honours maxDepth', () => {
    const g = graph({ 'src/a.ts': ['src/b.ts'], 'src/b.ts': ['src/c.ts'] })
    expect(blastRadius(['src/a.ts'], g, 1)).toEqual([
      { file: 'src/a.ts', depth: 0 },
      { file: 'src/b.ts', depth: 1 },
    ])
  })

  it('treats every seed as depth 0, even one that imports another seed', () => {
    // b imports a; both are seeds -> b stays depth 0, not 1
    const g = graph({ 'src/a.ts': ['src/b.ts'] })
    const out = blastRadius(['src/a.ts', 'src/b.ts'], g)
    expect(out.find((x) => x.file === 'src/b.ts')).toEqual({ file: 'src/b.ts', depth: 0 })
  })

  it('dedupes duplicate seeds', () => {
    expect(blastRadius(['src/a.ts', 'src/a.ts'], graph({}))).toEqual([{ file: 'src/a.ts', depth: 0 }])
  })
})

describe('extractKeywords (card title+desc -> search tokens)', () => {
  it('lowercases, splits on non-alphanumeric, dedupes preserving order', () => {
    expect(extractKeywords('ACK-capability', 'ACK registry hardening')).toEqual([
      'ack',
      'capability',
      'registry',
      'hardening',
    ])
  })

  it('drops stopwords and short tokens', () => {
    // 'the', 'to', 'a' are stopwords; 'v2' is too short (<3)
    const out = extractKeywords('Add the watchdog', 'a fix to v2 supervisor')
    expect(out).not.toContain('the')
    expect(out).not.toContain('to')
    expect(out).not.toContain('a')
    expect(out).not.toContain('v2')
    expect(out).toContain('watchdog')
    expect(out).toContain('supervisor')
  })

  it('returns empty for empty input', () => {
    expect(extractKeywords('', '')).toEqual([])
  })
})

describe('rankSpecs (existing-spec relevance)', () => {
  const specs = [
    { path: 'store/specs/ack.md', text: 'ack registry capability declare hook' },
    { path: 'store/specs/memory.md', text: 'memory tier hot warm cold' },
    { path: 'store/specs/gate.md', text: 'merge gate approvals reviewers' },
  ]

  it('scores by distinct matched tokens, descending', () => {
    const out = rankSpecs(['ack', 'registry', 'capability'], specs)
    expect(out[0]).toEqual({ path: 'store/specs/ack.md', score: 3 })
  })

  it('drops specs with no token match', () => {
    const out = rankSpecs(['ack'], specs)
    expect(out.map((s) => s.path)).toEqual(['store/specs/ack.md'])
  })

  it('tie-breaks by path ascending', () => {
    const out = rankSpecs(['hot', 'gate'], [
      { path: 'store/specs/zzz.md', text: 'gate' },
      { path: 'store/specs/aaa.md', text: 'hot' },
    ])
    expect(out.map((s) => s.path)).toEqual(['store/specs/aaa.md', 'store/specs/zzz.md'])
  })
})

describe('selectSymbolHits (card keywords -> defined symbols, exported-first)', () => {
  const symbols = [
    { name: 'readAgentAckCapable', kind: 'function', file: 'src/web/agent-config.ts', line: 334, exported: true },
    { name: 'ackInternalHelper', kind: 'function', file: 'src/web/agent-config.ts', line: 10, exported: false },
    { name: 'startWebServer', kind: 'function', file: 'src/web.ts', line: 71, exported: true },
  ]

  it('matches symbols whose name contains a keyword (case-insensitive substring)', () => {
    const out = selectSymbolHits(['ack'], symbols)
    expect(out.map((s) => s.name).sort()).toEqual(['ackInternalHelper', 'readAgentAckCapable'])
  })

  it('prioritises exported symbols', () => {
    const out = selectSymbolHits(['ack'], symbols)
    expect(out[0]).toMatchObject({ name: 'readAgentAckCapable', exported: true })
  })

  it('ignores keywords shorter than 3 chars', () => {
    expect(selectSymbolHits(['ab'], symbols)).toEqual([])
  })
})

describe('specsMentioningSymbol (cross-spec also-in-spec flag)', () => {
  const specs = [
    { path: 'store/specs/memory-privacy.md', text: 'readAgentAckCapable is referenced here' },
    { path: 'store/specs/other.md', text: 'unrelated content' },
  ]

  it('returns specs that mention the exact symbol name', () => {
    expect(specsMentioningSymbol('readAgentAckCapable', specs)).toEqual(['store/specs/memory-privacy.md'])
  })

  it('returns empty when no spec mentions it', () => {
    expect(specsMentioningSymbol('startWebServer', specs)).toEqual([])
  })
})

describe('buildImpactReport (orchestrator)', () => {
  const SYMBOLS = [
    { name: 'readAgentAckCapable', kind: 'function', file: 'src/web/agent-config.ts', line: 334, exported: true },
    { name: 'declareAck', kind: 'function', file: 'src/web/ack-registry.ts', line: 12, exported: true },
  ]
  const SPECS = [
    { path: 'store/specs/ack.md', text: 'ack registry capability declareAck' },
    { path: 'store/specs/privacy.md', text: 'mentions readAgentAckCapable in passing' },
  ]
  // a imported by b
  const IMPORTERS: Record<string, string[]> = { 'src/web/ack-registry.ts': ['src/web/agent-config.ts'] }

  function deps(over: Partial<ImpactDeps> = {}): ImpactDeps {
    return {
      importersOf: (f) => IMPORTERS[f] ?? [],
      allSymbols: () => SYMBOLS,
      specCorpus: () => SPECS,
      searchHotMemory: (kw) => (kw.includes('ack') ? [{ id: 1, content: 'ack work', category: 'hot', keywords: 'ack' }] : []),
      getCard: (id) => (id === 'c1' ? { title: 'ACK registry', description: 'declareAck hardening' } : null),
      getCardFiles: () => null,
      diffFiles: () => [],
      index: () => ({ indexed_at: 1_700_000_000, stale: false }),
      ...over,
    }
  }

  it('diff mode: seeds from the diff, computes transitive blast radius', () => {
    const r = buildImpactReport(
      { kind: 'diff', ref: 'develop...HEAD' },
      deps({ diffFiles: () => ['src/web/ack-registry.ts'] }),
    )
    expect(r.input.kind).toBe('diff')
    expect(r.seed_files).toEqual(['src/web/ack-registry.ts'])
    // ack-registry is imported by agent-config -> blast radius includes it at depth 1
    expect(r.affected).toContainEqual({ file: 'src/web/agent-config.ts', depth: 1 })
    expect(r.index).toEqual({ indexed_at: 1_700_000_000, stale: false })
  })

  it('card mode with an existing branch: branch-diff resolution', () => {
    const r = buildImpactReport(
      { kind: 'card', cardId: 'c1' },
      deps({ getCardFiles: () => ['src/web/ack-registry.ts'] }),
    )
    expect(r.input.resolution).toBe('branch-diff')
    expect(r.seed_files).toEqual(['src/web/ack-registry.ts'])
    expect(r.affected).toContainEqual({ file: 'src/web/agent-config.ts', depth: 1 })
  })

  it('card mode with no code yet: keyword resolution over symbols/specs/memory', () => {
    const r = buildImpactReport({ kind: 'card', cardId: 'c1' }, deps({ getCardFiles: () => null }))
    expect(r.input.resolution).toBe('keyword')
    // keyword 'ack' matches both symbols -> their files seed the blast radius
    expect(r.seed_files.sort()).toEqual(['src/web/ack-registry.ts', 'src/web/agent-config.ts'])
    expect(r.symbols.map((s) => s.name)).toContain('readAgentAckCapable')
    // exported-first ordering preserved
    expect(r.symbols[0].exported).toBe(true)
    // cross-spec flag: readAgentAckCapable also mentioned in privacy.md
    const seam = r.symbols.find((s) => s.name === 'readAgentAckCapable')
    expect(seam?.also_in_spec).toEqual(['store/specs/privacy.md'])
    // ranked specs + hot memory present
    expect(r.specs.length).toBeGreaterThan(0)
    expect(r.hot_memory).toHaveLength(1)
  })

  it('throws on an unknown card', () => {
    expect(() => buildImpactReport({ kind: 'card', cardId: 'nope' }, deps())).toThrow(/card/i)
  })
})
