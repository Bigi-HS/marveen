import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import {
  instrumentCheck,
  strikeGate,
  strikeClear,
  effectDrainCheck,
  type Logger,
} from '../lib/detector-common.js'

// Silent logger stub for unit tests.
const nullLog: Logger = {
  warn: () => undefined,
  info: () => undefined,
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'detector-common-test-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// instrumentCheck
// ---------------------------------------------------------------------------
describe('instrumentCheck', () => {
  it('ARM-A FAIL: probe fires on healthy agent => returns false', () => {
    const probeAlways = (_agent: string) => true
    expect(instrumentCheck(probeAlways, 'healthy', 'bad', nullLog)).toBe(false)
  })

  it('ARM-B FAIL: probe never fires => blind on bad fixture => returns false', () => {
    const probeNever = (_agent: string) => false
    expect(instrumentCheck(probeNever, 'healthy', 'bad', nullLog)).toBe(false)
  })

  it('both arms PASS: probe fires only on bad fixture => returns true', () => {
    const probeSelective = (agent: string) => agent === 'bad'
    expect(instrumentCheck(probeSelective, 'healthy', 'bad', nullLog)).toBe(true)
  })

  it('ARM-A FAIL logs a warning with healthyAgent field', () => {
    const warnings: Array<Record<string, unknown>> = []
    const log: Logger = {
      warn: (obj) => { warnings.push(obj) },
      info: () => undefined,
    }
    const probeAlways = (_agent: string) => true
    instrumentCheck(probeAlways, 'myagent', 'bad', log)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ healthyAgent: 'myagent' })
  })

  it('ARM-B FAIL logs a warning with badFixture field', () => {
    const warnings: Array<Record<string, unknown>> = []
    const log: Logger = {
      warn: (obj) => { warnings.push(obj) },
      info: () => undefined,
    }
    const probeNever = (_agent: string) => false
    instrumentCheck(probeNever, 'healthy', 'myfixture', log)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ badFixture: 'myfixture' })
  })
})

// ---------------------------------------------------------------------------
// strikeGate
// ---------------------------------------------------------------------------
describe('strikeGate', () => {
  it('first strike: returns false, strike file created', () => {
    const confirmed = strikeGate('a1', tmp, 60)
    expect(confirmed).toBe(false)
    expect(existsSync(join(tmp, 'strike-a1'))).toBe(true)
    expect(existsSync(join(tmp, 'strike-latch-a1'))).toBe(false)
  })

  it('second strike within window: returns true (confirmed)', () => {
    strikeGate('a2', tmp, 60)
    const confirmed = strikeGate('a2', tmp, 60)
    expect(confirmed).toBe(true)
    expect(existsSync(join(tmp, 'strike-a2'))).toBe(false)
    expect(existsSync(join(tmp, 'strike-latch-a2'))).toBe(true)
  })

  it('confirmed-latch: third call suppressed (returns false)', () => {
    strikeGate('a3', tmp, 60)
    strikeGate('a3', tmp, 60)
    const suppressed = strikeGate('a3', tmp, 60)
    expect(suppressed).toBe(false)
    expect(existsSync(join(tmp, 'strike-a3'))).toBe(false)
  })

  it('stale first strike: resets to new first strike (returns false)', () => {
    const staleTs = Math.floor(Date.now() / 1000) - 700
    writeFileSync(join(tmp, 'strike-a4'), String(staleTs))
    const confirmed = strikeGate('a4', tmp, 60)
    expect(confirmed).toBe(false)
    const newTs = parseInt(readFileSync(join(tmp, 'strike-a4'), 'utf8').trim(), 10)
    expect(newTs).toBeGreaterThan(staleTs)
  })

  it('expired latch: new strike cycle starts fresh', () => {
    // Write an expired latch (latch_window=5, written 10s ago)
    const expiredTs = Math.floor(Date.now() / 1000) - 10
    writeFileSync(join(tmp, 'strike-latch-a5'), String(expiredTs))
    // First strike should proceed normally
    const first = strikeGate('a5', tmp, 60, 5)
    expect(first).toBe(false)
    expect(existsSync(join(tmp, 'strike-latch-a5'))).toBe(false)
    expect(existsSync(join(tmp, 'strike-a5'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// strikeClear
// ---------------------------------------------------------------------------
describe('strikeClear', () => {
  it('removes both strike and latch files', () => {
    writeFileSync(join(tmp, 'strike-x'), '123')
    writeFileSync(join(tmp, 'strike-latch-x'), '123')
    strikeClear('x', tmp)
    expect(existsSync(join(tmp, 'strike-x'))).toBe(false)
    expect(existsSync(join(tmp, 'strike-latch-x'))).toBe(false)
  })

  it('no-op when files do not exist', () => {
    expect(() => strikeClear('nonexistent', tmp)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// SEC-106: agent-name validation / path-traversal guard
// strikeGate and strikeClear build file paths from `agent`; a name containing
// a path separator or traversal segment could escape stateDir. Reject with a
// throw (allowlist: ^[a-z0-9_-]+$ case-insensitive).
// ---------------------------------------------------------------------------
describe('SEC-106 agent-name validation', () => {
  const MALICIOUS = [
    '../evil',
    '../../etc/passwd',
    'a/b',
    'a\\b',
    'a b',
    '',
    '.',
    '..',
    'a;rm -rf',
    'a$(whoami)',
    'a\n b',
  ]

  for (const name of MALICIOUS) {
    it(`strikeGate rejects malicious agent name ${JSON.stringify(name)}`, () => {
      expect(() => strikeGate(name, tmp, 60)).toThrow(/invalid agent name/)
      // No strike file must be created anywhere inside stateDir for a rejected name.
      expect(existsSync(join(tmp, `strike-${name}`))).toBe(false)
    })

    it(`strikeClear rejects malicious agent name ${JSON.stringify(name)}`, () => {
      expect(() => strikeClear(name, tmp)).toThrow(/invalid agent name/)
    })
  }

  it('does not delete a file outside stateDir via traversal', () => {
    // A sibling file next to stateDir must survive a traversal attempt.
    const sibling = join(tmp, '..', `sec106-canary-${Math.random().toString(36).slice(2)}`)
    writeFileSync(sibling, 'keep')
    try {
      // `strike-../<canary>` would resolve to the sibling if unguarded.
      const evil = `../${sibling.split('/').pop()}`
      expect(() => strikeClear(evil, join(tmp, 'state-sub'))).toThrow(/invalid agent name/)
      expect(existsSync(sibling)).toBe(true)
    } finally {
      rmSync(sibling, { force: true })
    }
  })

  for (const name of ['agent-1', 'agent_2', 'Dave', 'marveen', 'ABC123']) {
    it(`accepts valid agent name ${JSON.stringify(name)}`, () => {
      expect(() => strikeGate(name, tmp, 60)).not.toThrow()
      expect(existsSync(join(tmp, `strike-${name}`))).toBe(true)
      expect(() => strikeClear(name, tmp)).not.toThrow()
      expect(existsSync(join(tmp, `strike-${name}`))).toBe(false)
    })
  }
})

// ---------------------------------------------------------------------------
// effectDrainCheck (ARM-B proof: positive-control test is mandatory by design)
// ---------------------------------------------------------------------------
describe('effectDrainCheck', () => {
  function makeDb(rows: Array<{ agent: string; deliveredAt: number }>): string {
    const dbPath = join(tmp, `noa-${Math.random().toString(36).slice(2)}.db`)
    const db = new Database(dbPath)
    db.exec('CREATE TABLE agent_messages (to_agent TEXT, delivered_at INTEGER)')
    const insert = db.prepare('INSERT INTO agent_messages VALUES (?, ?)')
    for (const r of rows) insert.run(r.agent, r.deliveredAt)
    db.close()
    return dbPath
  }

  const now = () => Math.floor(Date.now() / 1000)

  it('ARM-B positive-control: recent message => returns true (probe fires on known-bad fixture)', () => {
    const dbPath = makeDb([{ agent: 'target', deliveredAt: now() - 30 }])
    expect(effectDrainCheck('target', dbPath, 60)).toBe(true)
  })

  it('no recent messages (all older than interval) => returns false', () => {
    const dbPath = makeDb([{ agent: 'target', deliveredAt: now() - 120 }])
    expect(effectDrainCheck('target', dbPath, 60)).toBe(false)
  })

  it('empty table => returns false', () => {
    const dbPath = makeDb([])
    expect(effectDrainCheck('target', dbPath, 60)).toBe(false)
  })

  it('wrong agent => returns false', () => {
    const dbPath = makeDb([{ agent: 'other', deliveredAt: now() - 10 }])
    expect(effectDrainCheck('target', dbPath, 60)).toBe(false)
  })

  it('DB path does not exist => returns false (fail-open)', () => {
    expect(effectDrainCheck('target', '/nonexistent/path.db', 60)).toBe(false)
  })

  it('message exactly at interval boundary is NOT counted (strict >)', () => {
    const dbPath = makeDb([{ agent: 'target', deliveredAt: now() - 60 }])
    expect(effectDrainCheck('target', dbPath, 60)).toBe(false)
  })
})
