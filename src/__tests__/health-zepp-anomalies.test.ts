// GET /api/health/zepp/anomalies surface logic (WELL-028 G3 / card 44783957 P0).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZeppAnomalyStore, type AnomalyRule } from '../web/zepp/anomaly-store.js'
import { computeAnomalies } from '../web/routes/health-zepp-anomalies.js'

const SUSPECT: AnomalyRule[] = [
  { rule: 'distance/steps coherence', severity: 'suspect', message: 'distance 456m implausible for 15790 steps' },
]

describe('computeAnomalies', () => {
  let root: string
  let store: ZeppAnomalyStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'anomaly-endpoint-'))
    store = new ZeppAnomalyStore(root)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('returns open flags with an openCount by default', () => {
    store.record('2026-08-25', SUSPECT, '2026-08-25T10:00:00Z')
    const out = computeAnomalies(store, false)
    expect(out.anomalies.map((f) => f.date)).toEqual(['2026-08-25'])
    expect(out.openCount).toBe(1)
    expect(typeof out.checkedAt).toBe('string')
  })

  it('excludes resolved flags by default but includes them with includeResolved', () => {
    store.record('2026-08-24', SUSPECT, '2026-08-24T10:00:00Z')
    store.record('2026-08-25', SUSPECT, '2026-08-25T10:00:00Z')
    store.record('2026-08-24', [], '2026-08-24T20:00:00Z') // resolve 08-24

    const openOnly = computeAnomalies(store, false)
    expect(openOnly.anomalies.map((f) => f.date)).toEqual(['2026-08-25'])
    expect(openOnly.openCount).toBe(1)

    const all = computeAnomalies(store, true)
    expect(all.anomalies.map((f) => f.date)).toEqual(['2026-08-24', '2026-08-25'])
    expect(all.openCount).toBe(1) // openCount always reflects OPEN flags
  })

  it('returns an empty set when there are no anomalies', () => {
    const out = computeAnomalies(store, false)
    expect(out.anomalies).toEqual([])
    expect(out.openCount).toBe(0)
  })
})
