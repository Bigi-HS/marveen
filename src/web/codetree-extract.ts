import * as ts from 'typescript'
import { posix } from 'node:path'

// Phase-1 symbol kinds (see spec code_symbols.kind CHECK domain).
export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'const' | 'enum'

export interface ExtractedSymbol {
  name: string
  kind: SymbolKind
  line: number // 1-based
  exported: boolean
}

export interface ExtractedImport {
  to_module: string // raw import specifier, exactly as written
  imported_names: string[] | null // named imports; null for namespace/default/side-effect/star
}

export interface ExtractedCall {
  caller_symbol: string | null // enclosing top-level symbol; null = module scope
  callee_name: string // rightmost identifier of the call/new target
  line: number // 1-based
}

export interface FileExtraction {
  symbols: ExtractedSymbol[]
  imports: ExtractedImport[]
  calls: ExtractedCall[]
}

const MODULE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/

export function stripModuleExt(p: string): string {
  return p.replace(MODULE_EXT_RE, '')
}

// Resolve a raw import specifier (as written in source) to a comparison key.
// Relative specifiers are joined against the importing file's repo-relative dir
// and extension-stripped (e.g. './db.js' from 'src/server.ts' -> 'src/db').
// Package specifiers are returned unchanged.
export function resolveImportTarget(fromFileRel: string, rawSpecifier: string): string {
  if (rawSpecifier.startsWith('.')) {
    const joined = posix.normalize(posix.join(posix.dirname(fromFileRel), rawSpecifier))
    return stripModuleExt(joined)
  }
  return rawSpecifier
}

// Normalize a user-supplied ?module= query to the same key space: strip any
// leading ./ or ../ segments and the extension.
export function normalizeModuleQuery(q: string): string {
  return stripModuleExt(q.replace(/^(\.\.\/|\.\/)+/, ''))
}

// CT-AC3: an import edge matches a module query when the resolved target equals
// the normalized query, or (loose form, for bare './db'-style queries) shares a
// basename. Basename collisions across directories are a known Phase-1 caveat;
// the consumer disambiguates by from_file.
export function importMatchesQuery(fromFileRel: string, rawSpecifier: string, query: string): boolean {
  const resolved = resolveImportTarget(fromFileRel, rawSpecifier)
  const q = normalizeModuleQuery(query)
  if (resolved === q) return true
  return posix.basename(resolved) === posix.basename(q)
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false
  const mods = ts.getModifiers(node)
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function namedImportNames(clause: ts.ImportClause | undefined): string[] | null {
  if (!clause) return null
  const bindings = clause.namedBindings
  if (bindings && ts.isNamedImports(bindings)) {
    return bindings.elements.map((e) => e.name.text)
  }
  // namespace import (* as ns) or default-only -> null
  return null
}

// The static name of a call/new target: `foo()` -> 'foo', `a.b.c()` -> 'c'
// (rightmost property name). Computed (`obj[x]()`) and other non-identifier
// targets have no static name and are skipped -- the graph is name-based and
// resolved at query time, matching the import-edge model (noResolve rebuild).
function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text
  return null
}

// The top-level symbol a statement defines, used to attribute the calls in its
// body. A multi-declarator variable statement has no single owner -> null (its
// calls are treated as module scope), matching the single-owner attribution the
// caller graph needs.
function topLevelSymbolName(stmt: ts.Statement): string | null {
  if (ts.isFunctionDeclaration(stmt) && stmt.name) return stmt.name.text
  if (ts.isClassDeclaration(stmt) && stmt.name) return stmt.name.text
  if (ts.isVariableStatement(stmt)) {
    const decls = stmt.declarationList.declarations
    if (decls.length === 1 && ts.isIdentifier(decls[0].name)) return decls[0].name.text
  }
  return null
}

// Collect every call/new expression under `node`, each attributed to
// `callerSymbol`. forEachChild recursion also descends into arguments and the
// callee expression, so nested/argument calls are captured too.
function collectCalls(node: ts.Node, callerSymbol: string | null, sf: ts.SourceFile, out: ExtractedCall[]): void {
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const name = calleeName(n.expression)
      if (name) out.push({ caller_symbol: callerSymbol, callee_name: name, line: lineOf(sf, n) })
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
}

// Parse one already-parsed SourceFile into top-level symbols + import edges +
// call edges. Pure: no IO, no DB. The rebuild passes program.getSourceFile()
// outputs here; tests pass ts.createSourceFile() fixtures. Same AST either way.
export function extractFromSourceFile(sf: ts.SourceFile): FileExtraction {
  const symbols: ExtractedSymbol[] = []
  const imports: ExtractedImport[] = []
  const calls: ExtractedCall[] = []
  // Local names re-exported via a bare `export { a, b as c }` clause; used to
  // promote the matching internal symbol to exported (CT-AC8 recall).
  const exportedLocalNames = new Set<string>()

  for (const stmt of sf.statements) {
    // Call edges: attribute every call in this statement's subtree to the
    // top-level symbol it defines (or null for module-scope statements).
    if (!ts.isImportDeclaration(stmt) && !ts.isExportDeclaration(stmt)) {
      collectCalls(stmt, topLevelSymbolName(stmt), sf, calls)
    }

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      symbols.push({ name: stmt.name.text, kind: 'function', line: lineOf(sf, stmt), exported: hasExportModifier(stmt) })
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      symbols.push({ name: stmt.name.text, kind: 'class', line: lineOf(sf, stmt), exported: hasExportModifier(stmt) })
    } else if (ts.isInterfaceDeclaration(stmt)) {
      symbols.push({ name: stmt.name.text, kind: 'interface', line: lineOf(sf, stmt), exported: hasExportModifier(stmt) })
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      symbols.push({ name: stmt.name.text, kind: 'type', line: lineOf(sf, stmt), exported: hasExportModifier(stmt) })
    } else if (ts.isEnumDeclaration(stmt)) {
      symbols.push({ name: stmt.name.text, kind: 'enum', line: lineOf(sf, stmt), exported: hasExportModifier(stmt) })
    } else if (ts.isVariableStatement(stmt)) {
      const exported = hasExportModifier(stmt)
      const line = lineOf(sf, stmt)
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          symbols.push({ name: decl.name.text, kind: 'const', line, exported })
        }
      }
    } else if (ts.isImportDeclaration(stmt)) {
      if (ts.isStringLiteral(stmt.moduleSpecifier)) {
        imports.push({ to_module: stmt.moduleSpecifier.text, imported_names: namedImportNames(stmt.importClause) })
      }
    } else if (ts.isExportDeclaration(stmt)) {
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        // Re-export `export ... from 'x'` -> an import edge.
        let names: string[] | null = null
        if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
          names = stmt.exportClause.elements.map((e) => e.name.text)
        }
        imports.push({ to_module: stmt.moduleSpecifier.text, imported_names: names })
      } else if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        // Local re-export `export { a, b as c }` -> promote the LOCAL names.
        for (const el of stmt.exportClause.elements) {
          exportedLocalNames.add((el.propertyName ?? el.name).text)
        }
      }
    }
  }

  if (exportedLocalNames.size > 0) {
    for (const s of symbols) {
      if (!s.exported && exportedLocalNames.has(s.name)) s.exported = true
    }
  }

  return { symbols, imports, calls }
}
