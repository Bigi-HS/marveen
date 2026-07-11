import { describe, it, expect } from 'vitest'
import { selectDeadCodeCandidates, DEADCODE_CAVEATS } from '../web/codetree-deadcode.js'
import type { SymbolRow, ImportRow } from '../web/codetree-db.js'

// Build the three reachability inputs the selector consumes. Only exported
// symbols are candidates; calleeNames is the distinct set of call-target names
// across every call edge; importEdges are the raw import edges.
function input(opts: {
  exported?: SymbolRow[]
  calls?: string[]
  imports?: ImportRow[]
}) {
  return {
    exportedSymbols: opts.exported ?? [],
    calleeNames: new Set(opts.calls ?? []),
    importEdges: opts.imports ?? [],
  }
}

const sym = (name: string, file: string, line = 1, kind = 'function'): SymbolRow => ({
  name,
  kind,
  file,
  line,
  exported: true,
})

describe('selectDeadCodeCandidates', () => {
  it('flags an exported symbol that is neither imported by name nor called', () => {
    const out = selectDeadCodeCandidates(input({ exported: [sym('orphan', 'src/a.ts', 10)] }))
    expect(out).toEqual([{ name: 'orphan', kind: 'function', file: 'src/a.ts', line: 10 }])
  })

  it('does NOT flag a symbol imported by name from another file', () => {
    const out = selectDeadCodeCandidates(
      input({
        exported: [sym('used', 'src/a.ts')],
        imports: [{ from_file: 'src/b.ts', to_module: './a.js', imported_names: ['used'] }],
      }),
    )
    expect(out).toEqual([])
  })

  it('resolves import edges to the symbol file via repo-relative form too', () => {
    const out = selectDeadCodeCandidates(
      input({
        exported: [sym('used', 'src/web/a.ts')],
        imports: [{ from_file: 'src/web/routes/x.ts', to_module: '../a.js', imported_names: ['used'] }],
      }),
    )
    expect(out).toEqual([])
  })

  it('does NOT flag a symbol that is called somewhere (name-based)', () => {
    const out = selectDeadCodeCandidates(
      input({ exported: [sym('doWork', 'src/a.ts')], calls: ['doWork'] }),
    )
    expect(out).toEqual([])
  })

  it('conservatively suppresses when the module is namespace/default/side-effect imported (null names)', () => {
    const out = selectDeadCodeCandidates(
      input({
        exported: [sym('maybeUsed', 'src/a.ts')],
        imports: [{ from_file: 'src/b.ts', to_module: './a.js', imported_names: null }],
      }),
    )
    expect(out).toEqual([])
  })

  it('flags a symbol whose file is imported, but only OTHER names are pulled in', () => {
    const out = selectDeadCodeCandidates(
      input({
        exported: [sym('dead', 'src/a.ts', 5), sym('alive', 'src/a.ts', 9)],
        imports: [{ from_file: 'src/b.ts', to_module: './a.js', imported_names: ['alive'] }],
      }),
    )
    expect(out).toEqual([{ name: 'dead', kind: 'function', file: 'src/a.ts', line: 5 }])
  })

  it('treats a re-export edge (export { S } from) as a reference', () => {
    // Re-exports are recorded as import edges with the re-exported names.
    const out = selectDeadCodeCandidates(
      input({
        exported: [sym('reExported', 'src/a.ts')],
        imports: [{ from_file: 'src/barrel.ts', to_module: './a.js', imported_names: ['reExported'] }],
      }),
    )
    expect(out).toEqual([])
  })

  it('ignores non-exported symbols entirely (only exports are candidates)', () => {
    // The caller passes exportedSymbols only, but guard the contract: an internal
    // symbol handed in by mistake is still evaluated on its merits, so the input
    // list is authoritative. Here we assert the selector does not invent entries.
    const out = selectDeadCodeCandidates(input({ exported: [] }))
    expect(out).toEqual([])
  })

  it('does not count a same-file self call as external use is irrelevant: name presence suppresses', () => {
    // A symbol called only within its own file still has its name in calleeNames,
    // so it is conservatively not flagged (name-based model).
    const out = selectDeadCodeCandidates(
      input({ exported: [sym('helper', 'src/a.ts')], calls: ['helper'] }),
    )
    expect(out).toEqual([])
  })

  it('sorts candidates by file then line', () => {
    const out = selectDeadCodeCandidates(
      input({
        exported: [
          sym('z', 'src/b.ts', 3),
          sym('a', 'src/a.ts', 20),
          sym('b', 'src/a.ts', 4),
        ],
      }),
    )
    expect(out.map((c) => `${c.file}:${c.line}`)).toEqual(['src/a.ts:4', 'src/a.ts:20', 'src/b.ts:3'])
  })

  it('carries the symbol kind through (interfaces/types can be dead too)', () => {
    const out = selectDeadCodeCandidates(
      input({ exported: [sym('DeadType', 'src/types.ts', 2, 'type')] }),
    )
    expect(out).toEqual([{ name: 'DeadType', kind: 'type', file: 'src/types.ts', line: 2 }])
  })

  it('exposes a non-empty caveats list documenting the known false-positive sources', () => {
    expect(Array.isArray(DEADCODE_CAVEATS)).toBe(true)
    expect(DEADCODE_CAVEATS.length).toBeGreaterThan(0)
    expect(DEADCODE_CAVEATS.join(' ').toLowerCase()).toContain('test')
  })
})
