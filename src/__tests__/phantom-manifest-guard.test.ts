import { describe, it, expect } from 'vitest'
import {
  matchGlob,
  globsIntersect,
  findParallelConflicts,
  findOverrunFiles,
} from '../phantom/manifest-guard.js'
import type { ManifestTask } from '../phantom/manifest-guard.js'

// Card 4e5e529a (E2), slice 1: the pure PRE/POST file-overlap guards the
// pipelined phantom runner is built on. No orchestration here -- just the
// glob matcher and the two conflict/overrun decisions, fully unit-tested.

describe('matchGlob (concrete path vs glob)', () => {
  it('matches an exact path', () => {
    expect(matchGlob('src/db.ts', 'src/db.ts')).toBe(true)
    expect(matchGlob('src/db.ts', 'src/web.ts')).toBe(false)
  })

  it('* matches within a single segment only (not across /)', () => {
    expect(matchGlob('src/web/agent.ts', 'src/web/*.ts')).toBe(true)
    expect(matchGlob('src/web/sub/agent.ts', 'src/web/*.ts')).toBe(false)
    expect(matchGlob('src/web/agent.ts', 'src/*/agent.ts')).toBe(true)
  })

  it('? matches exactly one non-slash char', () => {
    expect(matchGlob('a/b1.ts', 'a/b?.ts')).toBe(true)
    expect(matchGlob('a/b.ts', 'a/b?.ts')).toBe(false) // ? needs a char
    expect(matchGlob('a/b12.ts', 'a/b?.ts')).toBe(false)
  })

  it('** matches zero or more segments', () => {
    expect(matchGlob('src/db.ts', 'src/**')).toBe(true) // zero trailing? -> ** = []  then nothing left
    expect(matchGlob('src/web/routes/x.ts', 'src/**/x.ts')).toBe(true)
    expect(matchGlob('src/x.ts', 'src/**/x.ts')).toBe(true) // ** matches zero segments
    expect(matchGlob('other/x.ts', 'src/**/x.ts')).toBe(false)
    expect(matchGlob('src/a/b/c.ts', 'src/**')).toBe(true)
  })

  it('partial-segment globs combine * with literals', () => {
    expect(matchGlob('src/web/agent-process.ts', 'src/web/agent-*.ts')).toBe(true)
    expect(matchGlob('src/web/launcher.ts', 'src/web/agent-*.ts')).toBe(false)
  })
})

describe('globsIntersect (pattern vs pattern, PRE-validation core)', () => {
  it('identical patterns intersect', () => {
    expect(globsIntersect('src/db.ts', 'src/db.ts')).toBe(true)
  })

  it('disjoint concrete paths do not intersect', () => {
    expect(globsIntersect('src/db.ts', 'src/web.ts')).toBe(false)
    expect(globsIntersect('src/web/a.ts', 'src/web/b.ts')).toBe(false)
  })

  it('a concrete path intersects a glob that covers it', () => {
    expect(globsIntersect('src/web/agent.ts', 'src/web/*.ts')).toBe(true)
    expect(globsIntersect('src/web/*.ts', 'src/web/agent.ts')).toBe(true) // symmetric
    expect(globsIntersect('src/web/routes/x.ts', 'src/**')).toBe(true)
  })

  it('two overlapping globs intersect', () => {
    expect(globsIntersect('src/web/*.ts', 'src/*/agent.ts')).toBe(true) // common: src/web/agent.ts
    expect(globsIntersect('src/**', 'src/web/*.ts')).toBe(true)
  })

  it('globs over different dirs do not intersect', () => {
    expect(globsIntersect('src/web/*.ts', 'scripts/*.ts')).toBe(false)
    expect(globsIntersect('src/web/*.ts', 'src/cli/*.ts')).toBe(false)
  })

  it('partial-segment globs intersect only on a shared candidate', () => {
    expect(globsIntersect('src/web/agent-*.ts', 'src/web/*-process.ts')).toBe(true) // agent-process.ts
    expect(globsIntersect('src/web/agent-*.ts', 'src/web/launcher-*.ts')).toBe(false)
  })
})

const task = (id: string, files: string[], extra: Partial<ManifestTask> = {}): ManifestTask =>
  ({ id, files_touched: files, ...extra })

describe('findParallelConflicts (PRE-validation)', () => {
  it('flags two parallel tasks whose files_touched overlap', () => {
    const conflicts = findParallelConflicts([
      task('a', ['src/web/agent-process.ts']),
      task('b', ['src/web/agent-process.ts']),
    ])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ a: 'a', b: 'b', reason: 'files-overlap' })
  })

  it('does not flag tasks with disjoint files', () => {
    expect(findParallelConflicts([
      task('a', ['src/web/agent-process.ts']),
      task('b', ['src/web/launcher.ts']),
    ])).toEqual([])
  })

  it('flags overlap via glob coverage', () => {
    const conflicts = findParallelConflicts([
      task('a', ['src/web/*.ts']),
      task('b', ['src/web/launcher.ts']),
    ])
    expect(conflicts).toHaveLength(1)
  })

  it('does NOT flag a pair already ordered by depends_on (they are sequential)', () => {
    expect(findParallelConflicts([
      task('a', ['src/db.ts']),
      task('b', ['src/db.ts'], { depends_on: ['a'] }),
    ])).toEqual([])
  })

  it('does NOT flag a non-parallel (sequential) task', () => {
    expect(findParallelConflicts([
      task('a', ['src/db.ts']),
      task('b', ['src/db.ts'], { parallel: false }),
    ])).toEqual([])
  })

  it('flags an explicit conflicts_with even when files are disjoint', () => {
    const conflicts = findParallelConflicts([
      task('a', ['src/x.ts'], { conflicts_with: ['b'] }),
      task('b', ['src/y.ts']),
    ])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].reason).toBe('declared-conflict')
  })

  it('reports each conflicting pair once', () => {
    const conflicts = findParallelConflicts([
      task('a', ['src/db.ts']),
      task('b', ['src/db.ts']),
      task('c', ['src/db.ts']),
    ])
    // pairs: a-b, a-c, b-c
    expect(conflicts).toHaveLength(3)
  })
})

describe('findOverrunFiles (POST-validation: actual ⊆ declared)', () => {
  it('returns [] when every changed file matches a declared glob', () => {
    expect(findOverrunFiles(
      ['src/web/agent.ts', 'src/db.ts'],
      ['src/web/*.ts', 'src/db.ts'],
    )).toEqual([])
  })

  it('flags a changed file outside the declared globs (overrun)', () => {
    expect(findOverrunFiles(
      ['src/web/agent.ts', 'src/secret.ts'],
      ['src/web/*.ts'],
    )).toEqual(['src/secret.ts'])
  })

  it('flags everything when nothing was declared', () => {
    expect(findOverrunFiles(['a.ts', 'b.ts'], [])).toEqual(['a.ts', 'b.ts'])
  })

  it('honors ** declarations', () => {
    expect(findOverrunFiles(['src/web/routes/x.ts'], ['src/**'])).toEqual([])
  })
})
