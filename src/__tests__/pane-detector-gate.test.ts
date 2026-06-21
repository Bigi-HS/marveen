import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  paneDetectorGateStatus,
  readPaneDetectorGate,
  checkPaneDetectorGate,
  recordPaneDetectorSmokePass,
  paneDetectorMismatchFile,
  paneDetectorSmokePassedFile,
  __setDriftAlertFn,
  __resetPaneGateState,
  type DriftAlertFn,
} from '../web/pane-detector-gate.js'

// Card 56ad0fa3 (B1+B4): the pane-dependent wedge watchdogs must stand down on a
// Claude CLI drift until a pane-detector smoke re-validates the new version --
// turning the old alert-only notice into an enforced barrier.

describe('paneDetectorGateStatus (pure decision)', () => {
  it('is trusted when no CLI drift is flagged', () => {
    expect(paneDetectorGateStatus(null, null).trusted).toBe(true)
    expect(paneDetectorGateStatus('', '2.1.160').trusted).toBe(true)
    expect(paneDetectorGateStatus('   ', null).trusted).toBe(true)
  })

  it('is NOT trusted when drift is flagged and the smoke has not re-validated it', () => {
    const s = paneDetectorGateStatus('2.2.0', null)
    expect(s.trusted).toBe(false)
    expect(s.reason).toContain('2.2.0')
    expect(paneDetectorGateStatus('2.2.0', '2.1.160').trusted).toBe(false) // stale smoke
  })

  it('is trusted again once the smoke passed for exactly the drifted version', () => {
    expect(paneDetectorGateStatus('2.2.0', '2.2.0').trusted).toBe(true)
  })

  it('trims whitespace on both sides', () => {
    expect(paneDetectorGateStatus(' 2.2.0 ', '2.2.0\n').trusted).toBe(true)
    expect(paneDetectorGateStatus('2.2.0', ' 2.2.0 ').trusted).toBe(true)
  })
})

describe('gate IO round-trip (drift -> stand down -> smoke -> re-enable)', () => {
  let root: string
  let prevRoot: string | undefined

  beforeEach(() => {
    prevRoot = process.env.MARVEEN_ROOT
    root = mkdtempSync(join(tmpdir(), 'pane-gate-'))
    process.env.MARVEEN_ROOT = root
    mkdirSync(join(root, 'store', '.fleet-supervisor'), { recursive: true })
  })

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.MARVEEN_ROOT
    else process.env.MARVEEN_ROOT = prevRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('trusts when neither state file exists', () => {
    expect(readPaneDetectorGate().trusted).toBe(true)
    expect(checkPaneDetectorGate('stuck-input')).toBe(true)
  })

  it('stands the watchdog down on a written mismatch, re-enables after a smoke pass', () => {
    // Supervisor flags a drift.
    writeFileSync(paneDetectorMismatchFile(), '2.5.0\n')
    expect(readPaneDetectorGate().trusted).toBe(false)
    expect(checkPaneDetectorGate('wedged-queue')).toBe(false)

    // c12 smoke passes on the new version: records it AND clears the mismatch.
    recordPaneDetectorSmokePass('2.5.0')
    expect(existsSync(paneDetectorMismatchFile())).toBe(false)
    expect(readFileSync(paneDetectorSmokePassedFile(), 'utf-8').trim()).toBe('2.5.0')
    expect(readPaneDetectorGate().trusted).toBe(true)
    expect(checkPaneDetectorGate('wedged-queue')).toBe(true)
  })

  it('stays down if the smoke passed for a DIFFERENT version than the drift', () => {
    writeFileSync(paneDetectorMismatchFile(), '2.6.0\n')
    recordPaneDetectorSmokePass('2.5.0') // wrong version
    // recordPaneDetectorSmokePass removed the mismatch file, so re-flag the real drift.
    writeFileSync(paneDetectorMismatchFile(), '2.6.0\n')
    expect(readPaneDetectorGate().trusted).toBe(false)
  })

  it('rejects an empty smoke version', () => {
    expect(() => recordPaneDetectorSmokePass('   ')).toThrow()
  })
})

describe('B1: direct Telegram drift alert on first stand-down per mismatch version', () => {
  let root: string
  let prevRoot: string | undefined
  const alerts: Array<{ reason: string; version: string }> = []
  const spyFn: DriftAlertFn = async (reason, version) => {
    alerts.push({ reason, version })
  }

  beforeEach(() => {
    prevRoot = process.env.MARVEEN_ROOT
    root = mkdtempSync(join(tmpdir(), 'pane-gate-b1-'))
    process.env.MARVEEN_ROOT = root
    mkdirSync(join(root, 'store', '.fleet-supervisor'), { recursive: true })
    alerts.length = 0
    __setDriftAlertFn(spyFn)
    __resetPaneGateState()
    __setDriftAlertFn(spyFn) // re-inject after reset
  })

  afterEach(() => {
    if (prevRoot === undefined) delete process.env.MARVEEN_ROOT
    else process.env.MARVEEN_ROOT = prevRoot
    __resetPaneGateState()
    rmSync(root, { recursive: true, force: true })
  })

  it('fires alert once when first watchdog stands down on a drift', async () => {
    writeFileSync(paneDetectorMismatchFile(), '2.7.0\n')
    checkPaneDetectorGate('b1-watchdog-a')
    // Alert is async (fire-and-forget); yield the microtask queue.
    await Promise.resolve()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].version).toBe('2.7.0')
  })

  it('does NOT fire a second alert for the same mismatch version (dedup)', async () => {
    writeFileSync(paneDetectorMismatchFile(), '2.7.0\n')
    checkPaneDetectorGate('b1-watchdog-a')
    checkPaneDetectorGate('b1-watchdog-b') // second watchdog, same drift version
    await Promise.resolve()
    expect(alerts).toHaveLength(1) // only one alert despite two watchdogs
  })

  it('does NOT fire an alert when no drift is present', async () => {
    checkPaneDetectorGate('b1-watchdog-trusted')
    await Promise.resolve()
    expect(alerts).toHaveLength(0)
  })

  it('fires a new alert when a new mismatch version appears after a smoke pass', async () => {
    // First drift + smoke pass cycle.
    writeFileSync(paneDetectorMismatchFile(), '2.7.0\n')
    checkPaneDetectorGate('b1-cycle-wdog')
    await Promise.resolve()
    expect(alerts).toHaveLength(1)

    recordPaneDetectorSmokePass('2.7.0') // clears mismatch, re-enables
    checkPaneDetectorGate('b1-cycle-wdog') // now trusted again -> no alert

    // New drift on a different version.
    writeFileSync(paneDetectorMismatchFile(), '2.8.0\n')
    checkPaneDetectorGate('b1-cycle-wdog') // transitions to !trusted again
    await Promise.resolve()
    expect(alerts).toHaveLength(2)
    expect(alerts[1].version).toBe('2.8.0')
  })

  it('alert passes the reason and mismatch version to the alert function', async () => {
    writeFileSync(paneDetectorMismatchFile(), '3.0.0\n')
    checkPaneDetectorGate('b1-reason-check')
    await Promise.resolve()
    expect(alerts[0].version).toBe('3.0.0')
    expect(alerts[0].reason).toContain('3.0.0')
  })
})
