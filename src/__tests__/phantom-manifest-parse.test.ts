import { describe, it, expect } from 'vitest'
import {
  parseManifestTask,
  validateManifest,
  topoOrder,
  type ParsedTask,
} from '../phantom/manifest-parse.js'

// Card 4e5e529a (E2), slice 2: parse + validate the phantom-task-manifest schema
// (one JSON task per file) and order the tasks by their depends_on DAG. Pure, so
// the runner can reject a malformed/cyclic manifest before launching any phantom.

const FULL = {
  id: 'execfilesync-agent-process',
  card: '1d2665a2',
  title: 'execSync -> execFileSync in agent-process.ts',
  body: 'In src/web/agent-process.ts ...',
  files_touched: ['src/web/agent-process.ts'],
  depends_on: [],
  conflicts_with: [],
  parallel: true,
}

describe('parseManifestTask', () => {
  it('accepts a full valid task', () => {
    const r = parseManifestTask(FULL)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.task.id).toBe('execfilesync-agent-process')
  })

  it('applies defaults for the optional fields', () => {
    const r = parseManifestTask({
      id: 'x', card: 'abc12345', title: 't', body: 'b', files_touched: ['a.ts'],
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.task.depends_on).toEqual([])
      expect(r.task.conflicts_with).toEqual([])
      expect(r.task.parallel).toBe(true) // default parallel
    }
  })

  it('rejects a non-object', () => {
    expect(parseManifestTask(null).ok).toBe(false)
    expect(parseManifestTask('nope').ok).toBe(false)
    expect(parseManifestTask(42).ok).toBe(false)
  })

  it('reports every missing required field', () => {
    const r = parseManifestTask({})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      for (const f of ['id', 'card', 'title', 'body', 'files_touched']) {
        expect(r.errors.some(e => e.includes(f))).toBe(true)
      }
    }
  })

  it('rejects an empty files_touched', () => {
    const r = parseManifestTask({ ...FULL, files_touched: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.some(e => e.includes('files_touched'))).toBe(true)
  })

  it('rejects wrong types', () => {
    expect(parseManifestTask({ ...FULL, files_touched: 'a.ts' }).ok).toBe(false)
    expect(parseManifestTask({ ...FULL, depends_on: 'x' }).ok).toBe(false)
    expect(parseManifestTask({ ...FULL, parallel: 'yes' }).ok).toBe(false)
    expect(parseManifestTask({ ...FULL, id: 42 }).ok).toBe(false)
  })

  it('rejects non-string entries inside string arrays', () => {
    expect(parseManifestTask({ ...FULL, files_touched: ['a.ts', 3] }).ok).toBe(false)
    expect(parseManifestTask({ ...FULL, depends_on: ['ok', null] }).ok).toBe(false)
  })
})

const t = (id: string, deps: string[] = [], conflicts: string[] = []): ParsedTask => ({
  id, card: 'c0ffee00', title: id, body: 'b', files_touched: [`${id}.ts`],
  depends_on: deps, conflicts_with: conflicts, parallel: true,
})

describe('validateManifest (cross-task)', () => {
  it('passes a clean manifest', () => {
    expect(validateManifest([t('a'), t('b', ['a'])]).errors).toEqual([])
  })

  it('flags duplicate ids', () => {
    const { errors } = validateManifest([t('a'), t('a')])
    expect(errors.some(e => e.includes('a') && /dup/i.test(e))).toBe(true)
  })

  it('flags depends_on to an unknown id', () => {
    const { errors } = validateManifest([t('a', ['ghost'])])
    expect(errors.some(e => e.includes('ghost'))).toBe(true)
  })

  it('flags conflicts_with to an unknown id', () => {
    const { errors } = validateManifest([t('a', [], ['ghost'])])
    expect(errors.some(e => e.includes('ghost'))).toBe(true)
  })

  it('flags a dependency cycle', () => {
    const { errors } = validateManifest([t('a', ['b']), t('b', ['a'])])
    expect(errors.some(e => /cycle/i.test(e))).toBe(true)
  })

  it('flags a self-dependency as a cycle', () => {
    const { errors } = validateManifest([t('a', ['a'])])
    expect(errors.some(e => /cycle/i.test(e))).toBe(true)
  })
})

describe('topoOrder (depends_on DAG)', () => {
  it('orders dependencies before dependents', () => {
    const r = topoOrder([t('c', ['b']), t('b', ['a']), t('a')])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.order.indexOf('a')).toBeLessThan(r.order.indexOf('b'))
      expect(r.order.indexOf('b')).toBeLessThan(r.order.indexOf('c'))
    }
  })

  it('keeps all independent tasks', () => {
    const r = topoOrder([t('a'), t('b'), t('c')])
    expect(r.ok).toBe(true)
    if (r.ok) expect([...r.order].sort()).toEqual(['a', 'b', 'c'])
  })

  it('reports the cycle instead of an order', () => {
    const r = topoOrder([t('a', ['b']), t('b', ['a'])])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.cycle).toContain('a')
      expect(r.cycle).toContain('b')
    }
  })
})
