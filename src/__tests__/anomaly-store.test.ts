// Persistent cross-field anomaly flag store (WELL-028 G3 / card 44783957 P0).
//
// The plausibility guard DETECTS a suspect snapshot (e.g. the BUG-2 cross-field anomaly:
// steps large but distance ~0) but historically only LOGGED it -- a silent observer. This
// store persists the suspect signal as a queryable health flag so a monitor/endpoint can
// surface it. Self-correcting: a later clean push resolves an open flag, mirroring the
// step-estimate remediation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZeppAnomalyStore, type AnomalyRule } from '../web/zepp/anomaly-store.js'

const SUSPECT: AnomalyRule[] = [
  { rule: 'distance/steps coherence', severity: 'suspect', message: 'distance 456m implausible for 15790 steps' },
]

describe('ZeppAnomalyStore', () => {
  let root: string
  let store: ZeppAnomalyStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'anomaly-store-'))
    store = new ZeppAnomalyStore(root)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('records an open flag when suspect rules are present', () => {
    const flag = store.record('2026-08-25', SUSPECT, '2026-08-25T10:00:00Z')
    expect(flag).not.toBeNull()
    expect(flag?.resolved).toBe(false)
    expect(flag?.date).toBe('2026-08-25')
    expect(flag?.detectedAt).toBe('2026-08-25T10:00:00Z')
    expect(flag?.rules).toEqual(SUSPECT)
    expect(store.get('2026-08-25')?.resolved).toBe(false)
  })

  it('does not create a flag when there are no suspect rules and none exists', () => {
    const flag = store.record('2026-08-25', [], '2026-08-25T10:00:00Z')
    expect(flag).toBeNull()
    expect(store.get('2026-08-25')).toBeNull()
    expect(existsSync(join(root, 'anomaly-2026-08-25.json'))).toBe(false)
  })

  it('keeps the original detectedAt while a flag stays open across re-detections', () => {
    store.record('2026-08-25', SUSPECT, '2026-08-25T10:00:00Z')
    const again = store.record('2026-08-25', SUSPECT, '2026-08-25T11:00:00Z')
    expect(again?.detectedAt).toBe('2026-08-25T10:00:00Z') // first detection preserved
    expect(again?.updatedAt).toBe('2026-08-25T11:00:00Z') // last record moves
    expect(again?.resolved).toBe(false)
  })

  it('resolves an open flag when a later clean push carries no suspect rules', () => {
    store.record('2026-08-25', SUSPECT, '2026-08-25T10:00:00Z')
    const resolved = store.record('2026-08-25', [], '2026-08-25T12:00:00Z')
    expect(resolved?.resolved).toBe(true)
    expect(resolved?.resolvedAt).toBe('2026-08-25T12:00:00Z')
    expect(resolved?.detectedAt).toBe('2026-08-25T10:00:00Z') // audit trail kept
    expect(store.get('2026-08-25')?.resolved).toBe(true)
  })

  it('does not touch an already-resolved flag when a clean push repeats', () => {
    store.record('2026-08-25', SUSPECT, '2026-08-25T10:00:00Z')
    store.record('2026-08-25', [], '2026-08-25T12:00:00Z')
    const noop = store.record('2026-08-25', [], '2026-08-25T13:00:00Z')
    expect(noop?.resolved).toBe(true)
    expect(noop?.resolvedAt).toBe('2026-08-25T12:00:00Z') // unchanged
  })

  it('re-opens with a fresh detectedAt when a resolved day goes suspect again', () => {
    store.record('2026-08-25', SUSPECT, '2026-08-25T10:00:00Z')
    store.record('2026-08-25', [], '2026-08-25T12:00:00Z')
    const reopened = store.record('2026-08-25', SUSPECT, '2026-08-25T14:00:00Z')
    expect(reopened?.resolved).toBe(false)
    expect(reopened?.detectedAt).toBe('2026-08-25T14:00:00Z') // new episode
    expect(reopened?.resolvedAt).toBeUndefined()
  })

  it('lists only open flags, sorted by date', () => {
    store.record('2026-08-24', SUSPECT, '2026-08-24T10:00:00Z')
    store.record('2026-08-25', SUSPECT, '2026-08-25T10:00:00Z')
    store.record('2026-08-24', [], '2026-08-24T20:00:00Z') // resolve 08-24
    const open = store.listOpen()
    expect(open.map((f) => f.date)).toEqual(['2026-08-25'])
  })

  it('rejects a malformed date (path-traversal guard), writes nothing', () => {
    expect(() => store.record('../../etc/passwd', SUSPECT, '2026-08-25T10:00:00Z')).toThrow()
    expect(store.get('../../etc/passwd')).toBeNull()
  })

  it('survives a corrupt flag file (returns null, does not throw)', () => {
    store.record('2026-08-25', SUSPECT, '2026-08-25T10:00:00Z')
    // corrupt the file
    const p = join(root, 'anomaly-2026-08-25.json')
    require('node:fs').writeFileSync(p, '{not json')
    expect(store.get('2026-08-25')).toBeNull()
    expect(store.listOpen()).toEqual([])
  })
})
