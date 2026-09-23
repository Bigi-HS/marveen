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

  // ---------------------------------------------------------------------------
  // WELL-66e35b2c: hibiki hand-build writer emits `_date` instead of `date`.
  // The reader must recover using the filename as the authoritative date key,
  // so the freshness route never sees latestDate=null ("latest data never").
  //
  // Adversarial fixtures (3-fixture rule for a signal-detector change):
  //   1. FALSE-NEGATIVE (the bug): _date-only file -> read() must return correct date
  //   2. FALSE-POSITIVE guard: valid file with date field is returned unchanged
  //   3. OPPOSITE combination: _date != filename -> filename wins (not _date)
  // ---------------------------------------------------------------------------
  describe('_date field normalisation (WELL-66e35b2c)', () => {
    const { writeFileSync: wf } = require('node:fs') as typeof import('node:fs')

    it('FALSE-NEGATIVE: a file written with _date (no date) is recovered via filename', () => {
      // Reproduces the hibiki hand-build shape. Before the fix, read() returned
      // the snapshot with date=undefined -> latest().date=undefined ->
      // freshness route latestDate=null -> "latest data never" alert every day.
      const raw = {
        _date: '2026-09-21',
        status: 'ok',
        source: 'manual-vision',
        sleep: { durationMin: 430, startAt: '2026-09-20T22:00:00Z', endAt: '2026-09-21T05:00:00Z', score: 80 },
      }
      wf(join(dir, 'daily-2026-09-21.json'), JSON.stringify(raw), { mode: 0o600 })

      const snap = store.read('2026-09-21')
      // Dangerous direction: date=undefined -> freshness route sees "never".
      expect(snap).not.toBeNull()
      expect(snap!.date).toBe('2026-09-21')
      // latest() must also surface the correct date (not null / undefined)
      expect(store.latest()?.date).toBe('2026-09-21')
    })

    it('FALSE-POSITIVE guard: a file with a valid date field is returned unchanged', () => {
      // The normalisation must NOT mutate a well-formed snapshot.
      const snap = makeSnapshot('2026-09-22', { status: 'ok' })
      store.write(snap)
      const read = store.read('2026-09-22')
      expect(read!.date).toBe('2026-09-22')
      expect(read).toEqual(snap)
    })

    it('OPPOSITE: if _date disagrees with filename, the filename (canonical key) wins', () => {
      // daily-2026-09-20.json containing _date: 2026-09-19 must be read back
      // with date='2026-09-20'. The filename is what listDates / latest() sort on.
      const raw = { _date: '2026-09-19', status: 'ok' }
      wf(join(dir, 'daily-2026-09-20.json'), JSON.stringify(raw), { mode: 0o600 })
      expect(store.read('2026-09-20')!.date).toBe('2026-09-20')
    })
  })

  // ENG-083: the store must validate `date` before it reaches path.join, so a
  // crafted date cannot escape the store directory. Defence-in-depth: the HTTP
  // ingest route already screens date, but the store is a reusable component and
  // other callers (cloud puller, programmatic writes) must not be able to traverse.
  describe('date validation (path-traversal guard)', () => {
    const TRAVERSAL_DATES = [
      '2026-08-22/../../etc/x',
      '../../../tmp/evil',
      '..',
      'foo/bar',
      '2026-08-22\0',
      '2026-8-2', // not zero-padded -> not a valid YYYY-MM-DD
      '',
      '2026_08_22',
    ]

    it('write() throws on a date that is not strict YYYY-MM-DD', () => {
      for (const bad of TRAVERSAL_DATES) {
        expect(() => store.write(makeSnapshot(bad)), `date=${JSON.stringify(bad)}`).toThrow(
          /invalid snapshot date/i,
        )
      }
    })

    it('write() with a traversal date does not create any file outside the store root', () => {
      const { readdirSync } = require('node:fs') as typeof import('node:fs')
      expect(() => store.write(makeSnapshot('2026-08-22/../../escape'))).toThrow()
      // The store dir stays empty; nothing leaked to a parent path.
      expect(readdirSync(dir)).toHaveLength(0)
    })

    it('read() returns null for a non-YYYY-MM-DD date instead of touching a traversed path', () => {
      for (const bad of TRAVERSAL_DATES) {
        expect(store.read(bad)).toBeNull()
      }
    })

    it('accepts a well-formed YYYY-MM-DD date', () => {
      expect(() => store.write(makeSnapshot('2026-12-31'))).not.toThrow()
      expect(store.read('2026-12-31')?.date).toBe('2026-12-31')
    })
  })
})
