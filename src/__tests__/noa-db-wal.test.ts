// df9d4686: durable noa.db WAL growth fix. The server opened noa.db without a
// journal_size_limit (-1 default), so the -wal file never shrank after a reset and
// stayed stuck at its historical peak (~130MB) -> health-check / CI timeout FPs.
// The fix is a bounded journal_size_limit on open PLUS an active periodic
// wal_checkpoint(TRUNCATE), because a passive autocheckpoint under overlapping
// readers may never fully reset the WAL.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import {
  openNoaDb,
  initNoaDb,
  getNoaDb,
  checkpointNoaDb,
  startWalMaintenance,
  stopWalMaintenance,
  WAL_JOURNAL_SIZE_LIMIT_BYTES,
  WAL_CHECKPOINT_INTERVAL_MS,
} from '../noa-db.js'
import { PROJECT_ROOT } from '../config.js'

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'waldb-'))
}

// Grow the WAL deterministically: disable the passive autocheckpoint so the
// -wal file accumulates instead of being reset mid-write, then bulk-insert.
function growWal(db: Database.Database, rows = 4000): void {
  db.pragma('wal_autocheckpoint = 0')
  db.exec('CREATE TABLE IF NOT EXISTS blob_t (id INTEGER PRIMARY KEY, v TEXT)')
  const ins = db.prepare('INSERT INTO blob_t (v) VALUES (?)')
  const big = 'x'.repeat(4096)
  const tx = db.transaction(() => { for (let i = 0; i < rows; i++) ins.run(big) })
  tx()
}

describe('noa-db WAL durability (df9d4686)', () => {
  afterEach(() => {
    stopWalMaintenance()
    vi.useRealTimers()
  })

  // AC-1: the missing backstop. journal_size_limit must be a bounded positive cap,
  // not the -1 default that let the WAL stay at its peak forever.
  it('AC-1: openNoaDb sets a bounded journal_size_limit (not the -1 default)', () => {
    const dir = freshDir()
    const db = openNoaDb(join(dir, 'x.db'))
    const lim = db.pragma('journal_size_limit', { simple: true }) as number
    expect(lim).toBe(WAL_JOURNAL_SIZE_LIMIT_BYTES)
    expect(WAL_JOURNAL_SIZE_LIMIT_BYTES).toBeGreaterThan(0)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // AC-1 baseline (guard, non-vacuous): a plain connection WITHOUT the pragma
  // reports -1 -> proves the pragma in openNoaDb is what changes the behaviour.
  it('AC-1b: a raw connection without the fix defaults journal_size_limit to -1', () => {
    const dir = freshDir()
    const raw = new Database(join(dir, 'raw.db'))
    const lim = raw.pragma('journal_size_limit', { simple: true }) as number
    expect(lim).toBe(-1)
    raw.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // AC-2: an active TRUNCATE checkpoint flushes frames AND shrinks the -wal file.
  it('AC-2: checkpointNoaDb TRUNCATE shrinks the grown -wal file', () => {
    const dir = freshDir()
    const p = join(dir, 'noa.db')
    initNoaDb(p)
    const db = getNoaDb()
    growWal(db)
    const walPath = p + '-wal'
    const grown = existsSync(walPath) ? statSync(walPath).size : 0
    expect(grown).toBeGreaterThan(1_000_000) // WAL really grew (>1MB)

    // TRUNCATE reports {busy,log,checkpointed}=0 once the frames are flushed and
    // the file is truncated (a SQLite reporting quirk of this path); the real,
    // observable effect is the -wal file shrinking. busy===0 proves no reader
    // blocked the checkpoint.
    const res = checkpointNoaDb()
    expect(res.busy).toBe(0)

    const after = existsSync(walPath) ? statSync(walPath).size : 0
    expect(after).toBeLessThan(grown)          // truncated down
    expect(after).toBeLessThan(1_000_000)      // shrank to well under 1MB (empirically ~0)
    expect(after).toBeLessThanOrEqual(WAL_JOURNAL_SIZE_LIMIT_BYTES)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // AC-3: the periodic maintenance timer truncates the WAL on its own (non-vacuous:
  // fake timers advance -> the -wal shrinks without a manual checkpoint call).
  it('AC-3: startWalMaintenance periodically truncates the WAL', () => {
    vi.useFakeTimers()
    const dir = freshDir()
    const p = join(dir, 'noa.db')
    initNoaDb(p)
    const db = getNoaDb()
    growWal(db)
    const walPath = p + '-wal'
    const grown = existsSync(walPath) ? statSync(walPath).size : 0
    expect(grown).toBeGreaterThan(1_000_000)

    startWalMaintenance(1000)
    vi.advanceTimersByTime(1000)

    const after = existsSync(walPath) ? statSync(walPath).size : 0
    expect(after).toBeLessThan(grown)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // AC-3b: startWalMaintenance is idempotent (one timer, repeat calls return it).
  it('AC-3b: startWalMaintenance is idempotent', () => {
    const t1 = startWalMaintenance(WAL_CHECKPOINT_INTERVAL_MS)
    const t2 = startWalMaintenance(WAL_CHECKPOINT_INTERVAL_MS)
    expect(t1).toBe(t2)
  })

  // AC-4: the fix is wired into the real server boot, not just exported.
  it('AC-4: web.ts boot starts WAL maintenance', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'web.ts'), 'utf-8')
    expect(src).toContain('startWalMaintenance(')
    expect(src).toMatch(/import\s*{[^}]*startWalMaintenance[^}]*}\s*from\s*'\.\/noa-db\.js'/)
  })
})
