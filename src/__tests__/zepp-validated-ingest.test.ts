import { describe, it, expect, vi } from 'vitest'
import { writeValidatedSnapshot } from '../web/zepp/validated-ingest.js'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'

// A clean snapshot: ordered, in-band vitals -- no plausibility violation.
const CLEAN: ZeppDailySnapshot = {
  date: '2026-08-22',
  pulledAt: '2026-08-22T10:00:00Z',
  status: 'ok',
  vitals: { restingHr: 58, hrAvg: 74, hrMax: 150 },
}

// Implausible vitals: restingHr >= hrAvg -> Rule 4 'heart rate ordering' (suspect). Vitals is a
// field the PULL path writes, so this proves the shared funnel is meaningful for pulls too.
const SUSPECT: ZeppDailySnapshot = {
  date: '2026-08-25',
  pulledAt: '2026-08-25T10:00:00Z',
  status: 'ok',
  vitals: { restingHr: 80, hrAvg: 74, hrMax: 150 },
}

describe('writeValidatedSnapshot (shared validated write funnel, WELL-027 WS1)', () => {
  it('writes the snapshot exactly once, unchanged', () => {
    const writeSnapshot = vi.fn()
    const recordAnomaly = vi.fn()
    writeValidatedSnapshot(CLEAN, { writeSnapshot, recordAnomaly })
    expect(writeSnapshot).toHaveBeenCalledTimes(1)
    expect(writeSnapshot).toHaveBeenCalledWith(CLEAN)
  })

  it('records the suspect violations when the snapshot is implausible', () => {
    const writeSnapshot = vi.fn()
    const recordAnomaly = vi.fn()
    const violations = writeValidatedSnapshot(SUSPECT, { writeSnapshot, recordAnomaly })
    expect(recordAnomaly).toHaveBeenCalledTimes(1)
    const [date, suspect] = recordAnomaly.mock.calls[0]
    expect(date).toBe('2026-08-25')
    expect(suspect.length).toBeGreaterThan(0)
    expect(suspect.every((v: { severity: string }) => v.severity === 'suspect')).toBe(true)
    // returns ALL violations (incl. non-suspect) so a caller can additionally log
    expect(violations.some((v) => v.rule === 'heart rate ordering')).toBe(true)
  })

  it('records an EMPTY list for a clean snapshot so an open flag resolves', () => {
    const writeSnapshot = vi.fn()
    const recordAnomaly = vi.fn()
    writeValidatedSnapshot(CLEAN, { writeSnapshot, recordAnomaly })
    expect(recordAnomaly).toHaveBeenCalledWith('2026-08-22', [])
  })

  it('writes BEFORE recording -- the durable snapshot never depends on the anomaly record', () => {
    const order: string[] = []
    const writeSnapshot = vi.fn(() => order.push('write'))
    const recordAnomaly = vi.fn(() => order.push('record'))
    writeValidatedSnapshot(SUSPECT, { writeSnapshot, recordAnomaly })
    expect(order).toEqual(['write', 'record'])
  })
})
