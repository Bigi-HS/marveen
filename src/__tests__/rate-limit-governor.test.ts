import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  evaluateGovernor,
  runGovernorCycle,
  formatBudapestTime,
  readSnapshotFile,
  readStateFile,
  writeStateFile,
  INITIAL_STATE,
  PAUSE_THRESHOLD_PCT,
  RESUME_GRACE_SEC,
  type GovernorState,
  type Snapshot,
  type GovernorDeps,
  type GovernorCycleResult,
} from '../web/rate-limit-governor.js'
import type { FleetPauseRecord } from '../web/fleet-pause.js'

const NOW = 1_900_000_000
const snap = (used_percentage: number | null, resets_at?: number | null): Snapshot => ({
  rate_limits: { five_hour: {
    ...(used_percentage === null ? {} : { used_percentage }),
    ...(resets_at === undefined ? {} : resets_at === null ? {} : { resets_at }),
  } },
})

describe('evaluateGovernor', () => {
  it('does nothing while usage is below the threshold', () => {
    const d = evaluateGovernor(snap(50, NOW + 3600), { ...INITIAL_STATE }, NOW)
    expect(d.action).toBe('none')
    expect(d.state.phase).toBe('normal')
  })

  it('pauses (notifies) when usage crosses the threshold with a known reset', () => {
    const resets = NOW + 3600
    const d = evaluateGovernor(snap(99, resets), { ...INITIAL_STATE }, NOW)
    expect(d.action).toBe('pause')
    expect(d.state.phase).toBe('paused')
    expect(d.state.resetsAt).toBe(resets)
    expect(d.state.pauseNotifiedAt).toBe(NOW)
    expect(d.message).toContain('99%')
    // Resume time = reset + 2 minutes, surfaced in the message.
    expect(d.message).toContain(formatBudapestTime(resets + RESUME_GRACE_SEC))
  })

  it('treats the threshold as inclusive (exactly 98% pauses) and below stays normal', () => {
    expect(evaluateGovernor(snap(PAUSE_THRESHOLD_PCT, NOW + 10), { ...INITIAL_STATE }, NOW).action).toBe('pause')
    // 97% is now BELOW the 98% threshold -> no pause.
    expect(evaluateGovernor(snap(97, NOW + 10), { ...INITIAL_STATE }, NOW).action).toBe('none')
  })

  it('does NOT pause when over threshold but resets_at is missing (cannot schedule a resume)', () => {
    const d = evaluateGovernor(snap(99, null), { ...INITIAL_STATE }, NOW)
    expect(d.action).toBe('none')
    expect(d.state.phase).toBe('normal')
  })

  it('does nothing when the snapshot has no usage figure', () => {
    expect(evaluateGovernor(snap(null), { ...INITIAL_STATE }, NOW).action).toBe('none')
    expect(evaluateGovernor(null, { ...INITIAL_STATE }, NOW).action).toBe('none')
  })

  it('does not re-notify while already paused and waiting', () => {
    const paused: GovernorState = { phase: 'paused', resetsAt: NOW + 3600, pauseNotifiedAt: NOW, resumeNotifiedAt: null }
    const d = evaluateGovernor(snap(98, NOW + 3600), paused, NOW + 60)
    expect(d.action).toBe('none')
  })

  it('resumes once the grace period after the reset has passed', () => {
    const resets = NOW
    const paused: GovernorState = { phase: 'paused', resetsAt: resets, pauseNotifiedAt: resets - 3600, resumeNotifiedAt: null }
    const d = evaluateGovernor(snap(20, resets), paused, resets + RESUME_GRACE_SEC)
    expect(d.action).toBe('resume')
    expect(d.state.phase).toBe('normal')
    expect(d.state.resetsAt).toBeNull()
    expect(d.state.resumeNotifiedAt).toBe(resets + RESUME_GRACE_SEC)
    expect(d.message).toContain('folytatjuk')
  })

  it('stays paused on time, not on the usage figure (does not resume early just because pct dropped)', () => {
    const resets = NOW + 3600
    const paused: GovernorState = { phase: 'paused', resetsAt: resets, pauseNotifiedAt: NOW, resumeNotifiedAt: null }
    // Usage already back to 10% but the reset+grace has NOT passed -> keep waiting.
    const d = evaluateGovernor(snap(10, resets), paused, NOW + 100)
    expect(d.action).toBe('none')
    expect(d.state.phase).toBe('paused')
  })
})

describe('formatBudapestTime (Europe/Budapest, DST-aware)', () => {
  it('renders summer instants as CEST (UTC+2)', () => {
    const ep = Date.UTC(2026, 5, 8, 10, 0, 0) / 1000 // 2026-06-08 10:00 UTC
    const s = formatBudapestTime(ep)
    expect(s).toContain('2026')
    expect(s).toContain('12:00') // +2 in June
  })

  it('renders winter instants as CET (UTC+1)', () => {
    const ep = Date.UTC(2026, 0, 15, 10, 0, 0) / 1000 // 2026-01-15 10:00 UTC
    expect(formatBudapestTime(ep)).toContain('11:00') // +1 in January
  })
})

describe('runGovernorCycle (injected IO)', () => {
  function harness(
    snapshot: Snapshot | null,
    state: GovernorState,
    nowSec: number,
  ): {
    result: GovernorCycleResult
    sent: string[]
    written: GovernorState | null
    paused: FleetPauseRecord[]
    resumed: number
  } {
    const sent: string[] = []
    let written: GovernorState | null = null
    const paused: FleetPauseRecord[] = []
    let resumed = 0
    const deps: GovernorDeps = {
      readSnapshot: () => snapshot,
      readState: () => state,
      writeState: (s) => { written = s },
      notify: (m) => sent.push(m),
      nowSec: () => nowSec,
      pauseFleet: (r) => { paused.push(r) },
      resumeFleet: () => { resumed += 1 },
    }
    const result = runGovernorCycle(deps)
    return { result, sent, written, paused, resumed }
  }

  it('on pause: declares the sentinel, notifies once and persists the paused state', () => {
    const resets = NOW + 3600
    const { result, sent, written, paused, resumed } = harness(snap(99, resets), { ...INITIAL_STATE }, NOW)
    expect(result.action).toBe('pause')
    expect(result.pct).toBe(99)
    expect(sent).toHaveLength(1)
    expect(written?.phase).toBe('paused')
    // The fleet-pause sentinel is declared with resumeAt = reset + grace.
    expect(paused).toHaveLength(1)
    expect(paused[0].resumeAt).toBe(resets + RESUME_GRACE_SEC)
    expect(paused[0].pct).toBe(99)
    expect(paused[0].pausedAt).toBe(NOW)
    expect(resumed).toBe(0)
  })

  it('on no-op: neither notifies, writes state, nor touches the sentinel', () => {
    const { result, sent, written, paused, resumed } = harness(snap(40, NOW + 3600), { ...INITIAL_STATE }, NOW)
    expect(result.action).toBe('none')
    expect(sent).toHaveLength(0)
    expect(written).toBeNull()
    expect(paused).toHaveLength(0)
    expect(resumed).toBe(0)
  })

  it('on resume: clears the sentinel, notifies and clears the paused state', () => {
    const paused: GovernorState = { phase: 'paused', resetsAt: NOW, pauseNotifiedAt: NOW - 3600, resumeNotifiedAt: null }
    const r = harness(snap(15, NOW), paused, NOW + RESUME_GRACE_SEC)
    expect(r.result.action).toBe('resume')
    expect(r.sent).toHaveLength(1)
    expect(r.written?.phase).toBe('normal')
    expect(r.resumed).toBe(1)
    expect(r.paused).toHaveLength(0)
  })
})

describe('file-backed state IO', () => {
  it('returns the initial state when the file is missing or corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-'))
    expect(readStateFile(join(dir, 'nope.json'))).toEqual(INITIAL_STATE)
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    expect(readStateFile(bad)).toEqual(INITIAL_STATE)
  })

  it('round-trips state through write/read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-'))
    const path = join(dir, 'state.json')
    const state: GovernorState = { phase: 'paused', resetsAt: 123, pauseNotifiedAt: 100, resumeNotifiedAt: null }
    writeStateFile(state, path)
    expect(readStateFile(path)).toEqual(state)
  })

  it('reads a snapshot file, or null when absent/garbage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gov-'))
    const path = join(dir, 'snap.json')
    writeFileSync(path, JSON.stringify(snap(80, 555)))
    expect(readSnapshotFile(path)?.rate_limits?.five_hour?.used_percentage).toBe(80)
    expect(readSnapshotFile(join(dir, 'missing.json'))).toBeNull()
    writeFileSync(path, 'garbage')
    expect(readSnapshotFile(path)).toBeNull()
  })
})
