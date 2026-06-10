import { describe, expect, it, vi, beforeEach } from 'vitest'

// In-memory fake fs backing the IO tests, so recordDeploy/read/write never
// touch the real store/deploy-state.json.
const fsState: { content: string | null } = { content: null }
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (p: string) => (String(p).endsWith('deploy-state.json') ? fsState.content !== null : actual.existsSync(p)),
    readFileSync: ((p: string, enc?: unknown) => {
      if (String(p).endsWith('deploy-state.json')) {
        if (fsState.content === null) throw new Error('ENOENT')
        return fsState.content
      }
      return actual.readFileSync(p as string, enc as BufferEncoding)
    }) as typeof actual.readFileSync,
    writeFileSync: ((p: string, data: string) => {
      if (String(p).endsWith('deploy-state.json')) {
        fsState.content = data
        return
      }
      return actual.writeFileSync(p, data)
    }) as typeof actual.writeFileSync,
  }
})

import {
  buildDelta,
  classifyRisky,
  formatDelta,
  parseMergeLines,
  readDeployState,
  recordDeploy,
  writeDeployState,
  type MergedPr,
} from '../web/deploy-delta.js'

describe('parseMergeLines', () => {
  it('parses standard merge-PR oneline commits', () => {
    const raw = [
      'a8e3572 Merge PR #98: heartbeat scaffold authMode (Thor+Dave, Chad courtesy)',
      '6993128 Merge PR #99: deploy Medic break-glass operator bot live (Thor+Dave+Chad)',
    ].join('\n')
    const prs = parseMergeLines(raw)
    expect(prs).toHaveLength(2)
    expect(prs[0]).toEqual({
      sha: 'a8e3572',
      pr: 98,
      title: 'heartbeat scaffold authMode (Thor+Dave, Chad courtesy)',
    })
    expect(prs[1].pr).toBe(99)
  })

  it('ignores non-merge-PR lines (direct/squash commits) and blanks', () => {
    const raw = [
      'a8e3572 Merge PR #98: x',
      '933f3c8 feat(medic): deploy break-glass operator bot live',
      '',
      '   ',
      'deadbee chore: bump dep',
    ].join('\n')
    const prs = parseMergeLines(raw)
    expect(prs).toHaveLength(1)
    expect(prs[0].pr).toBe(98)
  })

  it('returns [] for empty input', () => {
    expect(parseMergeLines('')).toEqual([])
    expect(parseMergeLines('\n\n')).toEqual([])
  })

  it('accepts full-length SHAs too', () => {
    const prs = parseMergeLines('a8e3572d9e45dc93e975ee11bdce2b2c73c74225 Merge PR #100: docs catalog')
    expect(prs).toHaveLength(1)
    expect(prs[0].pr).toBe(100)
  })
})

describe('classifyRisky', () => {
  const mk = (pr: number, title: string): MergedPr => ({ pr, sha: 'abc1234', title })

  it('flags behaviour-changing surfaces by keyword', () => {
    const prs = [
      mk(1, 'fleet OAuth migration env-token'),
      mk(2, 'supervisor flock fd close on dashboard launch'),
      mk(3, 'rate-limit governor for fleet pause'),
      mk(4, 'tweak heartbeat summary formatting'),
    ]
    const risky = classifyRisky(prs)
    const flagged = risky.map((r) => r.pr).sort()
    expect(flagged).toEqual([1, 2, 3])
    expect(risky.find((r) => r.pr === 1)?.keyword).toBe('oauth')
    expect(risky.find((r) => r.pr === 3)?.keyword).toBe('rate-limit')
  })

  it('does not flag a benign title that merely contains a keyword substring', () => {
    // "author" must NOT match "auth"; "relaunchpad" must NOT match "launch".
    const prs = [mk(10, 'credit the author in the README'), mk(11, 'add relaunchpad copy')]
    expect(classifyRisky(prs)).toEqual([])
  })

  it('matches case-insensitively and reports the first matching keyword', () => {
    const risky = classifyRisky([mk(5, 'AUTH cookie SESSION rework')])
    expect(risky).toHaveLength(1)
    expect(risky[0].keyword).toBe('auth')
  })

  it('honours a custom keyword list', () => {
    const risky = classifyRisky([mk(6, 'change the widget color')], ['widget'])
    expect(risky).toHaveLength(1)
    expect(risky[0].keyword).toBe('widget')
  })
})

describe('buildDelta', () => {
  const log = ['a8e3572 Merge PR #98: heartbeat scaffold authMode', '6993128 Merge PR #99: deploy Medic watchdog'].join('\n')

  it('summarises a non-empty delta with risk flags', () => {
    const d = buildDelta('deadbee', 'a8e3572', log)
    expect(d.ahead).toBe(2)
    expect(d.clean).toBe(false)
    expect(d.baselineUnknown).toBe(false)
    expect(d.prs).toHaveLength(2)
    expect(d.risky.map((r) => r.pr)).toContain(99) // "watchdog"
  })

  it('is clean when there are no merged PRs and a baseline exists', () => {
    const d = buildDelta('deadbee', 'deadbee', '')
    expect(d.ahead).toBe(0)
    expect(d.clean).toBe(true)
    expect(d.baselineUnknown).toBe(false)
  })

  it('marks baselineUnknown (never clean) when no deployed tip is recorded', () => {
    const d = buildDelta('', 'a8e3572', '')
    expect(d.baselineUnknown).toBe(true)
    expect(d.clean).toBe(false)
  })
})

describe('formatDelta', () => {
  it('renders the no-baseline case', () => {
    const out = formatDelta(buildDelta('', 'a8e3572abc', ''))
    expect(out).toMatch(/NO recorded deployed tip/)
  })

  it('renders the clean case', () => {
    const out = formatDelta(buildDelta('deadbeef', 'deadbeef', ''))
    expect(out).toMatch(/CLEAN/)
  })

  it('lists PRs and tags risky ones in the dirty case', () => {
    const log = ['a8e3572 Merge PR #98: heartbeat scaffold', '6993128 Merge PR #85: fleet OAuth migration'].join('\n')
    const out = formatDelta(buildDelta('deadbee', 'a8e3572', log))
    expect(out).toMatch(/2 merged-but-undeployed/)
    expect(out).toMatch(/BEHAVIOUR-CHANGING/)
    expect(out).toMatch(/#85.*\[RISK: oauth\]/)
    expect(out).toMatch(/#98 heartbeat scaffold/)
  })
})

describe('recordDeploy / readDeployState round-trip (fs mocked)', () => {
  beforeEach(() => {
    fsState.content = null
  })

  it('returns null when no state file exists', () => {
    expect(readDeployState()).toBeNull()
  })

  it('records with an explicit sha + injected timestamp and reads it back', () => {
    const state = recordDeploy({ type: 'dashboard', sha: 'cafebabe', note: 'PR #98 batch', at: '2026-06-10T12:00:00.000Z' })
    expect(state).toEqual({
      deployedSha: 'cafebabe',
      deployedAt: '2026-06-10T12:00:00.000Z',
      deployType: 'dashboard',
      note: 'PR #98 batch',
    })
    expect(readDeployState()).toEqual(state)
  })

  it('defaults note to null and persists the launch-env type', () => {
    const state = recordDeploy({ type: 'launch-env', sha: 'abc1234', at: '2026-06-10T12:00:00.000Z' })
    expect(state.note).toBeNull()
    expect(state.deployType).toBe('launch-env')
  })

  it('writeDeployState emits trailing-newline JSON', () => {
    writeDeployState({ deployedSha: 'x', deployedAt: 'y', deployType: 'dashboard', note: null })
    expect(fsState.content?.endsWith('}\n')).toBe(true)
  })

  it('readDeployState rejects malformed state (missing deployedSha)', () => {
    fsState.content = JSON.stringify({ foo: 'bar' })
    expect(readDeployState()).toBeNull()
  })
})
