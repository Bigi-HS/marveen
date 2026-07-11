import { describe, it, expect } from 'vitest'
import * as ts from 'typescript'
import {
  extractFromSourceFile,
  resolveImportTarget,
  normalizeModuleQuery,
  importMatchesQuery,
  stripModuleExt,
} from '../web/codetree-extract.js'

// Build a ts.SourceFile from a code string the same way the rebuild does from a
// real program SourceFile (parent nodes set so getStart()/modifiers resolve).
function sf(code: string, name = 'src/sample.ts'): ts.SourceFile {
  return ts.createSourceFile(name, code, ts.ScriptTarget.Latest, true)
}

describe('extractFromSourceFile — symbols', () => {
  it('extracts an exported function', () => {
    const { symbols } = extractFromSourceFile(sf('export function foo() { return 1 }'))
    expect(symbols).toContainEqual({ name: 'foo', kind: 'function', line: 1, exported: true })
  })

  it('marks a non-exported function as internal', () => {
    const { symbols } = extractFromSourceFile(sf('function bar() {}'))
    expect(symbols).toContainEqual({ name: 'bar', kind: 'function', line: 1, exported: false })
  })

  it('classifies class / interface / type / const / enum kinds', () => {
    const code = [
      'export class C {}',
      'export interface I { x: number }',
      'export type T = string | number',
      'export const k = 42',
      'export enum E { A, B }',
    ].join('\n')
    const { symbols } = extractFromSourceFile(sf(code))
    expect(symbols).toContainEqual({ name: 'C', kind: 'class', line: 1, exported: true })
    expect(symbols).toContainEqual({ name: 'I', kind: 'interface', line: 2, exported: true })
    expect(symbols).toContainEqual({ name: 'T', kind: 'type', line: 3, exported: true })
    expect(symbols).toContainEqual({ name: 'k', kind: 'const', line: 4, exported: true })
    expect(symbols).toContainEqual({ name: 'E', kind: 'enum', line: 5, exported: true })
  })

  it('reports correct 1-based line numbers', () => {
    const code = '\n\nexport function onLineThree() {}'
    const { symbols } = extractFromSourceFile(sf(code))
    expect(symbols.find((s) => s.name === 'onLineThree')?.line).toBe(3)
  })

  it('captures internal const without marking it exported', () => {
    const { symbols } = extractFromSourceFile(sf('const internal = 1'))
    expect(symbols).toContainEqual({ name: 'internal', kind: 'const', line: 1, exported: false })
  })

  it('handles export default function (named)', () => {
    const { symbols } = extractFromSourceFile(sf('export default function def() {}'))
    expect(symbols).toContainEqual({ name: 'def', kind: 'function', line: 1, exported: true })
  })

  it('promotes a symbol to exported via a later export { } clause (CT-AC8 recall)', () => {
    const code = 'function bar() {}\nexport { bar }'
    const { symbols } = extractFromSourceFile(sf(code))
    expect(symbols.find((s) => s.name === 'bar')?.exported).toBe(true)
  })

  it('promotes via export { local as alias } using the LOCAL name', () => {
    const code = 'function localName() {}\nexport { localName as publicName }'
    const { symbols } = extractFromSourceFile(sf(code))
    expect(symbols.find((s) => s.name === 'localName')?.exported).toBe(true)
  })

  it('multiple const declarators in one statement', () => {
    const { symbols } = extractFromSourceFile(sf('export const a = 1, b = 2'))
    expect(symbols).toContainEqual({ name: 'a', kind: 'const', line: 1, exported: true })
    expect(symbols).toContainEqual({ name: 'b', kind: 'const', line: 1, exported: true })
  })
})

describe('extractFromSourceFile — imports', () => {
  it('named imports record the names', () => {
    const { imports } = extractFromSourceFile(sf("import { a, b } from './x.js'"))
    expect(imports).toContainEqual({ to_module: './x.js', imported_names: ['a', 'b'] })
  })

  it('namespace import records null names', () => {
    const { imports } = extractFromSourceFile(sf("import * as ns from 'pkg'"))
    expect(imports).toContainEqual({ to_module: 'pkg', imported_names: null })
  })

  it('default import records null names', () => {
    const { imports } = extractFromSourceFile(sf("import def from './y.js'"))
    expect(imports).toContainEqual({ to_module: './y.js', imported_names: null })
  })

  it('default + named import records the named names', () => {
    const { imports } = extractFromSourceFile(sf("import def, { a } from './y.js'"))
    expect(imports).toContainEqual({ to_module: './y.js', imported_names: ['a'] })
  })

  it('side-effect import records null names', () => {
    const { imports } = extractFromSourceFile(sf("import './side-effect.js'"))
    expect(imports).toContainEqual({ to_module: './side-effect.js', imported_names: null })
  })

  it('export * from is recorded as a re-export edge with null names', () => {
    const { imports } = extractFromSourceFile(sf("export * from './z.js'"))
    expect(imports).toContainEqual({ to_module: './z.js', imported_names: null })
  })

  it('export { q } from is recorded as a re-export edge with the names', () => {
    const { imports } = extractFromSourceFile(sf("export { q } from './w.js'"))
    expect(imports).toContainEqual({ to_module: './w.js', imported_names: ['q'] })
  })

  it('a local export clause (no module specifier) is NOT an import edge', () => {
    const { imports } = extractFromSourceFile(sf('function bar() {}\nexport { bar }'))
    expect(imports).toHaveLength(0)
  })
})

describe('extractFromSourceFile — calls (Phase-2 call-path tracing)', () => {
  it('attributes a call to its enclosing top-level function', () => {
    const { calls } = extractFromSourceFile(sf('function outer() {\n  helper()\n}'))
    expect(calls).toContainEqual({ caller_symbol: 'outer', callee_name: 'helper', line: 2 })
  })

  it('uses the rightmost name of a property-access call (obj.method())', () => {
    const { calls } = extractFromSourceFile(sf('function f() {\n  db.saveRow()\n}'))
    expect(calls).toContainEqual({ caller_symbol: 'f', callee_name: 'saveRow', line: 2 })
  })

  it('uses the rightmost name of a deep property-access call (a.b.c())', () => {
    const { calls } = extractFromSourceFile(sf('function f() {\n  a.b.c()\n}'))
    expect(calls).toContainEqual({ caller_symbol: 'f', callee_name: 'c', line: 2 })
  })

  it('records a constructor call (new Foo()) as an edge to Foo', () => {
    const { calls } = extractFromSourceFile(sf('function make() {\n  return new Widget()\n}'))
    expect(calls).toContainEqual({ caller_symbol: 'make', callee_name: 'Widget', line: 2 })
  })

  it('attributes calls inside an arrow-function const to that const', () => {
    const { calls } = extractFromSourceFile(sf('const handler = () => {\n  process()\n}'))
    expect(calls).toContainEqual({ caller_symbol: 'handler', callee_name: 'process', line: 2 })
  })

  it('attributes calls inside a class method to the class name', () => {
    const { calls } = extractFromSourceFile(sf('class Svc {\n  run() {\n    doWork()\n  }\n}'))
    expect(calls).toContainEqual({ caller_symbol: 'Svc', callee_name: 'doWork', line: 3 })
  })

  it('records nested and argument calls, each attributed to the enclosing symbol', () => {
    const { calls } = extractFromSourceFile(sf('function f() {\n  outerCall(innerCall())\n}'))
    expect(calls).toContainEqual({ caller_symbol: 'f', callee_name: 'outerCall', line: 2 })
    expect(calls).toContainEqual({ caller_symbol: 'f', callee_name: 'innerCall', line: 2 })
  })

  it('attributes a module-scope call to a null caller', () => {
    const { calls } = extractFromSourceFile(sf('bootstrap()'))
    expect(calls).toContainEqual({ caller_symbol: null, callee_name: 'bootstrap', line: 1 })
  })

  it('attributes a call in a single-declarator const initializer to that const', () => {
    const { calls } = extractFromSourceFile(sf('const app = createApp()'))
    expect(calls).toContainEqual({ caller_symbol: 'app', callee_name: 'createApp', line: 1 })
  })

  it('ignores a computed call with no static name (obj[x]())', () => {
    const { calls } = extractFromSourceFile(sf('function f() {\n  reg[key]()\n}'))
    expect(calls).toEqual([])
  })

  it('attributes calls in a multi-declarator statement to a null caller', () => {
    const { calls } = extractFromSourceFile(sf('const a = one(), b = two()'))
    expect(calls).toContainEqual({ caller_symbol: null, callee_name: 'one', line: 1 })
    expect(calls).toContainEqual({ caller_symbol: null, callee_name: 'two', line: 1 })
  })
})

describe('module path resolution helpers', () => {
  it('stripModuleExt removes ts/js extensions', () => {
    expect(stripModuleExt('src/db.ts')).toBe('src/db')
    expect(stripModuleExt('src/db.js')).toBe('src/db')
    expect(stripModuleExt('better-sqlite3')).toBe('better-sqlite3')
  })

  it('resolveImportTarget resolves a sibling relative import', () => {
    expect(resolveImportTarget('src/server.ts', './db.js')).toBe('src/db')
  })

  it('resolveImportTarget resolves a parent relative import', () => {
    expect(resolveImportTarget('src/web/foo.ts', '../db.js')).toBe('src/db')
  })

  it('resolveImportTarget leaves a package specifier untouched', () => {
    expect(resolveImportTarget('src/x.ts', 'better-sqlite3')).toBe('better-sqlite3')
  })

  it('normalizeModuleQuery strips leading ./ ../ and extension', () => {
    expect(normalizeModuleQuery('src/db.ts')).toBe('src/db')
    expect(normalizeModuleQuery('./db')).toBe('db')
    expect(normalizeModuleQuery('../../db.js')).toBe('db')
  })

  it('CT-AC3: relative and repo-relative query forms match the SAME import edge', () => {
    const from = 'src/server.ts'
    const raw = './db.js'
    for (const q of ['src/db.ts', 'src/db', './db', 'db']) {
      expect(importMatchesQuery(from, raw, q)).toBe(true)
    }
  })

  it('CT-AC3: a package import matches its package-name query', () => {
    expect(importMatchesQuery('src/x.ts', 'better-sqlite3', 'better-sqlite3')).toBe(true)
  })

  it('does not match an unrelated module', () => {
    expect(importMatchesQuery('src/server.ts', './db.js', 'logger')).toBe(false)
  })
})
