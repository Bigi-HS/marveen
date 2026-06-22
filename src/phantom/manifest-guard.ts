// Card 4e5e529a (E2), slice 1: the pure file-overlap guards the pipelined
// phantom runner is built on. The runner (a Workflow script) parses one JSON
// task per file from the phantom-task-manifest schema; these functions are the
// mechanical decisions it makes, kept dependency-free and unit-tested so the
// orchestration layer can stay thin.
//
//   PRE-validation  -> findParallelConflicts: two tasks that would run in
//   parallel but whose declared files_touched globs intersect (or that name each
//   other in conflicts_with) must be serialised, not run concurrently.
//
//   POST-validation -> findOverrunFiles: after a phantom finishes, every file it
//   actually changed must be covered by its declared files_touched globs
//   (actual_changed_files subset of declared). Any file outside is an OVERRUN ->
//   flagged for human review, NOT auto-gated.
//
// No glob library is available in the tree, so matchGlob/globsIntersect below are
// a small self-contained matcher for the patterns the schema uses: concrete
// paths, `*` (within one path segment), `?` (one non-slash char) and `**` (zero
// or more whole segments), with `/` as the separator.

export interface ManifestTask {
  id: string
  files_touched: string[]
  depends_on?: string[]
  conflicts_with?: string[]
  parallel?: boolean
}

export interface Conflict {
  a: string
  b: string
  reason: 'files-overlap' | 'declared-conflict'
}

// --- glob matching (concrete path vs pattern) ---

export function matchGlob(path: string, pattern: string): boolean {
  return matchSegments(path.split('/'), pattern.split('/'))
}

function matchSegments(p: string[], g: string[]): boolean {
  if (g.length === 0) return p.length === 0
  if (g[0] === '**') {
    // ** consumes zero or more whole path segments.
    for (let i = 0; i <= p.length; i++) {
      if (matchSegments(p.slice(i), g.slice(1))) return true
    }
    return false
  }
  if (p.length === 0) return false
  if (!matchSegment(p[0], g[0])) return false
  return matchSegments(p.slice(1), g.slice(1))
}

// Single-segment match with `*` (zero+ chars, no slash) and `?` (one char).
function matchSegment(s: string, pat: string): boolean {
  function go(si: number, pi: number): boolean {
    if (pi === pat.length) return si === s.length
    const c = pat[pi]
    if (c === '*') {
      for (let k = si; k <= s.length; k++) if (go(k, pi + 1)) return true
      return false
    }
    if (si === s.length) return false
    if (c === '?' || c === s[si]) return go(si + 1, pi + 1)
    return false
  }
  return go(0, 0)
}

// --- glob intersection (pattern vs pattern) ---

// Do two globs share at least one common matching path? Exact for the *, ?, **
// segment globs above. Used by PRE-validation to decide whether two parallel
// tasks could touch the same file before any phantom runs.
export function globsIntersect(a: string, b: string): boolean {
  return segmentsIntersect(a.split('/'), b.split('/'))
}

function segmentsIntersect(a: string[], b: string[]): boolean {
  if (a.length === 0 && b.length === 0) return true
  // A leftover side can only still match if it is all `**` (each matching zero
  // segments).
  if (a.length === 0) return b.every(s => s === '**')
  if (b.length === 0) return a.every(s => s === '**')
  if (a[0] === '**') {
    // ** matches zero segments (advance a) or one+ segments (advance b, keep **).
    return segmentsIntersect(a.slice(1), b) || segmentsIntersect(a, b.slice(1))
  }
  if (b[0] === '**') {
    return segmentsIntersect(a, b.slice(1)) || segmentsIntersect(a.slice(1), b)
  }
  if (!segmentsGlobIntersect(a[0], b[0])) return false
  return segmentsIntersect(a.slice(1), b.slice(1))
}

// Do two single-segment globs (with `*`/`?`) share a common string?
function segmentsGlobIntersect(a: string, b: string): boolean {
  function go(ai: number, bi: number): boolean {
    if (ai === a.length && bi === b.length) return true
    if (ai === a.length) return restAllStar(b, bi)
    if (bi === b.length) return restAllStar(a, ai)
    const ca = a[ai], cb = b[bi]
    if (ca === '*') return go(ai + 1, bi) || go(ai, bi + 1) // * matches zero+ chars
    if (cb === '*') return go(ai, bi + 1) || go(ai + 1, bi)
    // neither is '*': '?' matches any single char the other side supplies.
    if (ca === '?' || cb === '?' || ca === cb) return go(ai + 1, bi + 1)
    return false
  }
  return go(0, 0)
}

function restAllStar(s: string, i: number): boolean {
  for (let k = i; k < s.length; k++) if (s[k] !== '*') return false
  return true
}

// --- PRE-validation: parallel-conflict detection ---

function anyGlobIntersects(a: string[], b: string[]): boolean {
  for (const ga of a) for (const gb of b) if (globsIntersect(ga, gb)) return true
  return false
}

function isOrderedPair(x: ManifestTask, y: ManifestTask): boolean {
  return (x.depends_on?.includes(y.id) ?? false) || (y.depends_on?.includes(x.id) ?? false)
}

function declaresConflict(x: ManifestTask, y: ManifestTask): boolean {
  return (x.conflicts_with?.includes(y.id) ?? false) || (y.conflicts_with?.includes(x.id) ?? false)
}

// Find every unordered pair of would-be-parallel tasks that must instead be
// serialised: either their files_touched globs intersect, or one names the other
// in conflicts_with. depends_on pairs and parallel:false tasks are already
// sequential and are skipped. Each conflicting pair is reported once.
export function findParallelConflicts(tasks: ManifestTask[]): Conflict[] {
  const conflicts: Conflict[] = []
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const x = tasks[i], y = tasks[j]
      if (x.parallel === false || y.parallel === false) continue
      if (isOrderedPair(x, y)) continue
      if (declaresConflict(x, y)) {
        conflicts.push({ a: x.id, b: y.id, reason: 'declared-conflict' })
      } else if (anyGlobIntersects(x.files_touched, y.files_touched)) {
        conflicts.push({ a: x.id, b: y.id, reason: 'files-overlap' })
      }
    }
  }
  return conflicts
}

// --- POST-validation: overrun detection ---

// Return the changed files NOT covered by any declared glob (the overrun set).
// Empty result means actual_changed_files is a subset of the declared globs.
export function findOverrunFiles(changedFiles: string[], declaredGlobs: string[]): string[] {
  return changedFiles.filter(f => !declaredGlobs.some(g => matchGlob(f, g)))
}
