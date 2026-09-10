import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import {
  netSleepMin,
  slpToZeppSleep,
  parseSummarySleep,
  readLocalDbSleep,
  makeDateDataReader,
  type ZeppSlp,
} from '../web/zepp/local-db-source.js'

// Real 2026-09-09 record pulled from the emulator's origin_db DATE_DATA.slp.
// dp142 + lt322 + rem0 = 464 min = 7h44m -- matched Boss's phone to the minute.
const SLP_0909: ZeppSlp = { dp: 142, lt: 322, rem: 0, dt: 145, st: 1788902400, ed: 1788939660, ss: 78 }

describe('netSleepMin', () => {
  it('sums deep+light+rem and excludes awake (the app-displayed net)', () => {
    expect(netSleepMin(SLP_0909)).toBe(464)
  })
  it('treats missing stage fields as zero', () => {
    expect(netSleepMin({ dp: 100 })).toBe(100)
    expect(netSleepMin({})).toBe(0)
  })
  it('ignores awake entirely -- awake is what Health Connect over-counts', () => {
    expect(netSleepMin({ dp: 10, lt: 20, rem: 5, dt: 999 })).toBe(35)
  })
})

describe('slpToZeppSleep', () => {
  it('maps a slp object to the ZeppSleep contract with net durationMin', () => {
    const s = slpToZeppSleep(SLP_0909, '2026-09-09')
    expect(s.durationMin).toBe(464)
    expect(s.stages).toEqual({ deep: 142, light: 322, rem: 0, awake: 145 })
    expect(s.score).toBe(78)
    expect(new Date(s.startAt).getTime()).toBe(1788902400 * 1000)
    expect(new Date(s.endAt).getTime()).toBe(1788939660 * 1000)
  })
  it('falls back to date-anchored timestamps when st/ed absent', () => {
    const s = slpToZeppSleep({ dp: 100, lt: 100 }, '2026-09-09')
    expect(s.startAt).toBe('2026-09-09T00:00:00Z')
    expect(s.endAt).toBe('2026-09-09T08:00:00Z')
  })
  it('omits score when ss is absent', () => {
    expect(slpToZeppSleep({ dp: 100 }, '2026-09-09').score).toBeUndefined()
  })
})

describe('parseSummarySleep', () => {
  it('parses a DATE_DATA SUMMARY JSON with a slp object', () => {
    const summary = JSON.stringify({ v: 5, stp: { ttl: 8000 }, slp: SLP_0909 })
    const s = parseSummarySleep(summary, '2026-09-09')
    expect(s?.durationMin).toBe(464)
  })
  it('returns null for malformed JSON', () => {
    expect(parseSummarySleep('{not json', '2026-09-09')).toBeNull()
  })
  it('returns null when there is no slp object', () => {
    expect(parseSummarySleep(JSON.stringify({ stp: { ttl: 8000 } }), '2026-09-09')).toBeNull()
  })
  it('returns null when slp has no measured asleep minutes (awake-only / empty)', () => {
    expect(parseSummarySleep(JSON.stringify({ slp: { dt: 30 } }), '2026-09-09')).toBeNull()
    expect(parseSummarySleep(JSON.stringify({ slp: {} }), '2026-09-09')).toBeNull()
  })
})

describe('readLocalDbSleep (injected reader)', () => {
  it('parses the SUMMARY the reader returns', () => {
    const summary = JSON.stringify({ slp: SLP_0909 })
    const s = readLocalDbSleep('2026-09-09', () => summary)
    expect(s?.durationMin).toBe(464)
  })
  it('returns null when the reader finds no row', () => {
    expect(readLocalDbSleep('2026-09-09', () => null)).toBeNull()
  })
})

describe('makeDateDataReader (real sqlite DATE_DATA)', () => {
  function fixtureDb() {
    const path = join(tmpdir(), `zepp-localdb-test-${process.pid}-${Math.floor(SLP_0909.st! % 100000)}.db`)
    rmSync(path, { force: true })
    const db = new Database(path)
    db.exec('CREATE TABLE DATE_DATA (TYPE INTEGER, DATE TEXT, SUMMARY TEXT)')
    const ins = db.prepare('INSERT INTO DATE_DATA (TYPE, DATE, SUMMARY) VALUES (?,?,?)')
    ins.run(0, '2026-09-09', JSON.stringify({ slp: SLP_0909, stp: { ttl: 9000 } }))
    ins.run(0, '2026-09-08', JSON.stringify({ slp: { dp: 103, lt: 231, rem: 0, dt: 85 } }))
    // a same-date row with no sleep must be skipped, not returned
    ins.run(1, '2026-09-09', JSON.stringify({ stp: { ttl: 500 } }))
    db.close()
    return path
  }

  it('reads the accurate net sleep for a date from a real DATE_DATA table', () => {
    const path = fixtureDb()
    const read = makeDateDataReader(path)
    expect(readLocalDbSleep('2026-09-09', read)?.durationMin).toBe(464)
    expect(readLocalDbSleep('2026-09-08', read)?.durationMin).toBe(334)
    rmSync(path, { force: true })
  })
  it('returns null for a date with no sleep row', () => {
    const path = fixtureDb()
    const read = makeDateDataReader(path)
    expect(readLocalDbSleep('2026-01-01', read)).toBeNull()
    rmSync(path, { force: true })
  })
})
