import * as ts from 'typescript'
import { readdirSync, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'
import { extractFromSourceFile } from './codetree-extract.js'
import { replaceIndexData, setIndexMeta, type SymbolRow, type ImportRow, type CallRow } from './codetree-db.js'

export interface RebuildOptions {
  rootDir?: string
  scanDirs?: string[]
}

export interface RebuildSummary {
  files_indexed: number
  symbols_indexed: number
  imports_indexed: number
  calls_indexed: number
  duration_ms: number
  indexed_at: string // ISO 8601 UTC
  files_skipped: Array<{ path: string; error: string }>
}

const DEFAULT_SCAN_DIRS = ['src', 'scripts']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '__tests__'])

function isIndexableFile(name: string): boolean {
  if (!name.endsWith('.ts') && !name.endsWith('.tsx')) return false
  if (name.endsWith('.d.ts')) return false
  if (name.endsWith('.test.ts') || name.endsWith('.spec.ts')) return false
  if (name.endsWith('.test.tsx') || name.endsWith('.spec.tsx')) return false
  return true
}

// Recursively collect indexable TS source files (absolute paths) under each
// scan dir. Excludes tests, .d.ts, and build/vendor dirs.
export function enumerateSourceFiles(rootDir: string, scanDirs: string[] = DEFAULT_SCAN_DIRS): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[]
    } catch {
      return // scan dir missing (e.g. no scripts/) -> skip silently
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        walk(join(dir, ent.name))
      } else if (ent.isFile() && isIndexableFile(ent.name)) {
        out.push(join(dir, ent.name))
      }
    }
  }
  for (const d of scanDirs) walk(join(rootDir, d))
  return out
}

function toRepoRelative(rootDir: string, absPath: string): string {
  return relative(rootDir, absPath).split(sep).join('/')
}

// Full rebuild of the codetree index. Uses the TypeScript compiler API
// (ts.createProgram, CT-AC8) for parsing — never regex. Assumes the codetree DB
// is already initialized by the caller. A per-file parse failure is recorded in
// files_skipped and does not abort the rebuild (spec edge case).
export function rebuildIndex(opts: RebuildOptions = {}): RebuildSummary {
  const rootDir = opts.rootDir ?? PROJECT_ROOT
  const scanDirs = opts.scanDirs ?? DEFAULT_SCAN_DIRS
  const startedAt = Date.now()

  const files = enumerateSourceFiles(rootDir, scanDirs)
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    allowJs: false,
    skipLibCheck: true,
    noEmit: true,
    noResolve: true, // syntactic extraction only; no module/type resolution needed
  })

  const symbols: SymbolRow[] = []
  const imports: ImportRow[] = []
  const calls: CallRow[] = []
  const filesSkipped: Array<{ path: string; error: string }> = []
  let filesIndexed = 0

  for (const abs of files) {
    const rel = toRepoRelative(rootDir, abs)
    const sf = program.getSourceFile(abs)
    if (!sf) {
      filesSkipped.push({ path: rel, error: 'source file not found in program' })
      continue
    }
    try {
      const { symbols: fileSymbols, imports: fileImports, calls: fileCalls } = extractFromSourceFile(sf)
      for (const s of fileSymbols) symbols.push({ ...s, file: rel })
      for (const i of fileImports) imports.push({ from_file: rel, to_module: i.to_module, imported_names: i.imported_names })
      for (const c of fileCalls) calls.push({ caller_file: rel, caller_symbol: c.caller_symbol, callee_name: c.callee_name, line: c.line })
      filesIndexed++
    } catch (err) {
      filesSkipped.push({ path: rel, error: err instanceof Error ? err.message : String(err) })
    }
  }

  replaceIndexData(symbols, imports, calls)
  const indexedAtEpoch = Math.floor(startedAt / 1000)
  setIndexMeta({
    indexed_at: indexedAtEpoch,
    files_count: filesIndexed,
    symbols_count: symbols.length,
    imports_count: imports.length,
    calls_count: calls.length,
  })

  const summary: RebuildSummary = {
    files_indexed: filesIndexed,
    symbols_indexed: symbols.length,
    imports_indexed: imports.length,
    calls_indexed: calls.length,
    duration_ms: Date.now() - startedAt,
    indexed_at: new Date(indexedAtEpoch * 1000).toISOString(),
    files_skipped: filesSkipped,
  }
  logger.info(
    { files: summary.files_indexed, symbols: summary.symbols_indexed, imports: summary.imports_indexed, calls: summary.calls_indexed, skipped: filesSkipped.length, ms: summary.duration_ms },
    'codetree index rebuilt',
  )
  return summary
}
