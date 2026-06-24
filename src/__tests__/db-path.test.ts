import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { resolveNoaDbPath } from '../db-path.js'

// Card 88849f24 + Chad #287 security finding: the noa.db cutover is driven by the
// NOA_DB_PATH env var. An unvalidated path is a traversal surface (a crafted
// value could point the live DB handle outside the project, or at a non-DB
// file). resolveNoaDbPath enforces: must resolve UNDER the project root, must
// end in .db, and any "../" escape is rejected. An unset value yields the
// default path (no behaviour change pre-cutover).

const ROOT = '/home/proj'
const DEFAULT = join(ROOT, 'store', 'claudeclaw.db')

describe('resolveNoaDbPath', () => {
  it('returns the default path when the env var is unset / empty / whitespace', () => {
    expect(resolveNoaDbPath(undefined, ROOT, DEFAULT)).toBe(DEFAULT)
    expect(resolveNoaDbPath('', ROOT, DEFAULT)).toBe(DEFAULT)
    expect(resolveNoaDbPath('   ', ROOT, DEFAULT)).toBe(DEFAULT)
  })

  it('resolves a valid relative .db path under the project root', () => {
    expect(resolveNoaDbPath('store/noa.db', ROOT, DEFAULT)).toBe(join(ROOT, 'store', 'noa.db'))
  })

  it('accepts a valid absolute .db path inside the project root', () => {
    const abs = join(ROOT, 'store', 'noa.db')
    expect(resolveNoaDbPath(abs, ROOT, DEFAULT)).toBe(abs)
  })

  it('trims surrounding whitespace before resolving', () => {
    expect(resolveNoaDbPath('  store/noa.db  ', ROOT, DEFAULT)).toBe(join(ROOT, 'store', 'noa.db'))
  })

  it('accepts an uppercase .DB suffix (case-insensitive)', () => {
    expect(resolveNoaDbPath('store/NOA.DB', ROOT, DEFAULT)).toBe(join(ROOT, 'store', 'NOA.DB'))
  })

  it('rejects a path that does not end in .db', () => {
    expect(() => resolveNoaDbPath('store/noa.txt', ROOT, DEFAULT)).toThrow(/\.db/)
    expect(() => resolveNoaDbPath('store/noa', ROOT, DEFAULT)).toThrow(/\.db/)
  })

  it('rejects a relative traversal that escapes the project root', () => {
    expect(() => resolveNoaDbPath('../evil.db', ROOT, DEFAULT)).toThrow(/root/i)
    expect(() => resolveNoaDbPath('store/../../evil.db', ROOT, DEFAULT)).toThrow(/root/i)
  })

  it('rejects an absolute path outside the project root', () => {
    expect(() => resolveNoaDbPath('/etc/passwd.db', ROOT, DEFAULT)).toThrow(/root/i)
    expect(() => resolveNoaDbPath('/home/proj-evil/x.db', ROOT, DEFAULT)).toThrow(/root/i)
  })

  it('does not treat the root itself (a non-file) as valid', () => {
    expect(() => resolveNoaDbPath('.', ROOT, DEFAULT)).toThrow()
  })
})
