import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZeppIngestStore } from '../web/zepp/ingest-store.js'
import type { ZeppDailySnapshot } from '../web/zepp/contract.js'

function makeSnapshot(date: string, over: Partial<ZeppDailySnapshot> = {}): ZeppDailySnapshot {
  return {
    date,
    pulledAt: '2026-08-22T10:00:00.000Z',
    status: 'ok',
    sleep: { durationMin: 420, startAt: '2026-08-21T23:00:00Z', endAt: '2026-08-22T06:00:00Z', score: 78 },
    steps: 8500,
    ...over,
  }
}

describe('ZeppIngestStore', () => {
  let dir: string
  let store: ZeppIngestStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zepp-test-'))
    store = new ZeppIngestStore(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes and reads back a snapshot', () => {
    const snap = makeSnapshot('2026-08-22')
    store.write(snap)
    const read = store.read('2026-08-22')
    expect(read).toEqual(snap)
  })

  it('returns null for a date with no snapshot', () => {
    expect(store.read('2026-01-01')).toBeNull()
  })

  it('overwrites an existing snapshot for the same date', () => {
    store.write(makeSnapshot('2026-08-22', { steps: 1000 }))
    store.write(makeSnapshot('2026-08-22', { steps: 9999 }))
    expect(store.read('2026-08-22')?.steps).toBe(9999)
  })

  it('listDates returns all stored dates sorted ascending', () => {
    store.write(makeSnapshot('2026-08-20'))
    store.write(makeSnapshot('2026-08-22'))
    store.write(makeSnapshot('2026-08-21'))
    expect(store.listDates()).toEqual(['2026-08-20', '2026-08-21', '2026-08-22'])
  })

  it('listDates returns empty array when nothing stored', () => {
    expect(store.listDates()).toEqual([])
  })

  it('latest() returns the most recent snapshot', () => {
    store.write(makeSnapshot('2026-08-20'))
    store.write(makeSnapshot('2026-08-22'))
    expect(store.latest()?.date).toBe('2026-08-22')
  })

  it('latest() returns null when empty', () => {
    expect(store.latest()).toBeNull()
  })

  it('written file has 0600 permissions', () => {
    const { statSync } = require('node:fs') as typeof import('node:fs')
    store.write(makeSnapshot('2026-08-22'))
    const mode = statSync(join(dir, 'daily-2026-08-22.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('store directory is created with 0700 permissions', () => {
    const { statSync } = require('node:fs') as typeof import('node:fs')
    const subDir = join(dir, 'sub-0700-test')
    new ZeppIngestStore(subDir)
    const mode = statSync(subDir).mode & 0o777
    expect(mode).toBe(0o700)
  })
})
