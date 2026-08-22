// Dead-code candidate detection (card 52815f7c, Phase-2 B) on top of the
// Phase-1/2 code knowledge graph. PURE core: no DB / git / HTTP. An exported
// symbol is a *candidate* when neither reachability signal references it:
//   1. import edges  -- some other file imports its name (or namespace/default/
//      side-effect imports its module, which conservatively suppresses),
//   2. call edges    -- its name appears as a call/new target anywhere.
//
// The output is DELIBERATELY named "candidate": the graph is name-based and
// syntactic, so the result is false-positive-prone (see DEADCODE_CAVEATS) and
// requires human confirmation. It is a review aid, never an auto-delete signal.

import { posix } from 'node:path'
import { importMatchesQuery, resolveImportTarget, normalizeModuleQuery } from './codetree-extract.js'
import type { SymbolRow, ImportRow } from './codetree-db.js'

export interface DeadCodeCandidate {
  name: string
  kind: string
  file: string
  line: number
}

export interface DeadCodeInput {
  /** Exported symbols only -- the candidate universe. */
  exportedSymbols: SymbolRow[]
  /** Distinct call-target names across every call edge. */
  calleeNames: Set<string>
  /** Every import edge (from_file, raw specifier, imported names). */
  importEdges: ImportRow[]
}

// Known blind spots that make a candidate a false positive. Shipped inline in
// the API response so the consumer sees what the detector does NOT catch and
// never derives an automated deletion from a candidate.
export const DEADCODE_CAVEATS: readonly string[] = [
  'Candidates require human confirmation -- this is a review aid, not an auto-delete signal.',
  'Test files are not indexed: a symbol used only by tests appears dead.',
  'Entry points (framework/CLI/bootstrap-invoked exports) have no in-code caller and appear dead.',
  'Dynamic or computed dispatch (obj[name](), string-keyed registries, reflection) is not tracked.',
  'Name-based graph: a same-named symbol elsewhere can mask a real dead symbol, or suppress a live one.',
  'Only src/ and scripts/ are indexed: references from unindexed files are not seen.',
]

// An import edge references a symbol's file when it resolves to that file AND
// either pulls the symbol in by name or is a namespace/default/side-effect
// import (null names -- conservatively treated as reachable).
function edgeReferences(edge: ImportRow, symbolFile: string, symbolName: string): boolean {
  if (!importMatchesQuery(edge.from_file, edge.to_module, symbolFile)) return false
  return edge.imported_names == null || edge.imported_names.includes(symbolName)
}

/**
 * Select exported symbols that no reachability signal references. Conservative:
 * any call by name, or any import (named-including or null-names) that resolves
 * to the symbol's file, keeps it out of the candidate set. Results are sorted by
 * file then line for a stable report.
 */
export function selectDeadCodeCandidates(input: DeadCodeInput): DeadCodeCandidate[] {
  const { exportedSymbols, calleeNames, importEdges } = input

  // importMatchesQuery is basename-keyed, so bucket edges by their resolved
  // target basename and test only the relevant bucket per symbol (avoids an
  // O(symbols x imports) scan on real ~2k-symbol indexes).
  const edgesByBasename = new Map<string, ImportRow[]>()
  for (const e of importEdges) {
    const key = posix.basename(resolveImportTarget(e.from_file, e.to_module))
    const arr = edgesByBasename.get(key)
    if (arr) arr.push(e)
    else edgesByBasename.set(key, [e])
  }

  const candidates: DeadCodeCandidate[] = []
  for (const s of exportedSymbols) {
    if (calleeNames.has(s.name)) continue // called somewhere by name
    const bucket = edgesByBasename.get(posix.basename(normalizeModuleQuery(s.file)))
    if (bucket && bucket.some((e) => edgeReferences(e, s.file, s.name))) continue
    candidates.push({ name: s.name, kind: s.kind, file: s.file, line: s.line })
  }

  candidates.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return candidates
}
