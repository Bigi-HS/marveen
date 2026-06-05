import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assessPipeLiveness,
  needsRecovery,
  reduceConflictProbes,
  shouldEscalate,
  nextState,
  formatRecoveryEvent,
  INITIAL_STATE,
  type WatchdogState,
} from '../web/telegram-pipe-watchdog.js'

// ---------------------------------------------------------------------------
// assessPipeLiveness -- the authoritative liveness verdict
// ---------------------------------------------------------------------------

describe('assessPipeLiveness', () => {
  it('a 409 conflict is authoritative -> healthy (even if presence is unknown)', () => {
    expect(assessPipeLiveness({ present: null, conflicted: true, probeStatus: 409 })).toBe('healthy')
  })

  it('a 409 conflict wins even when the presence probe says absent (race window)', () => {
    // conflicted proves a poller holds the slot RIGHT NOW; trust it over a
    // momentarily-stale presence read.
    expect(assessPipeLiveness({ present: false, conflicted: true, probeStatus: 409 })).toBe('healthy')
  })

  it('process certainly gone (present=false) with no conflict -> dead', () => {
    expect(assessPipeLiveness({ present: false, conflicted: false, probeStatus: 0 })).toBe('dead')
  })

  it('a clean 200 (free getUpdates slot) while a poller was expected -> dead', () => {
    expect(assessPipeLiveness({ present: true, conflicted: false, probeStatus: 200 })).toBe('dead')
  })

  it('network error (status 0) with present/unknown -> inconclusive (fail-safe)', () => {
    expect(assessPipeLiveness({ present: true, conflicted: false, probeStatus: 0 })).toBe('inconclusive')
    expect(assessPipeLiveness({ present: null, conflicted: false, probeStatus: 0 })).toBe('inconclusive')
  })

  it('a non-200 non-409 status (e.g. 500) without presence-absence -> inconclusive', () => {
    expect(assessPipeLiveness({ present: true, conflicted: false, probeStatus: 500 })).toBe('inconclusive')
  })
})

describe('needsRecovery', () => {
  it('only a dead verdict needs recovery', () => {
    expect(needsRecovery('dead')).toBe(true)
    expect(needsRecovery('healthy')).toBe(false)
    expect(needsRecovery('inconclusive')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// reduceConflictProbes -- poll-gap tolerance across in-cycle retries
// ---------------------------------------------------------------------------

describe('reduceConflictProbes', () => {
  it('any single 409 across the probes means alive (poll-gap tolerant)', () => {
    // A healthy long-poll is in-flight for one probe and gone (gap) for others.
    expect(reduceConflictProbes([
      { conflicted: false, status: 200 },
      { conflicted: true, status: 409 },
      { conflicted: false, status: 200 },
    ])).toEqual({ conflicted: true, status: 409 })
  })

  it('only declares 200 when EVERY probe saw a free slot (reliable dead)', () => {
    expect(reduceConflictProbes([
      { conflicted: false, status: 200 },
      { conflicted: false, status: 200 },
      { conflicted: false, status: 200 },
    ])).toEqual({ conflicted: false, status: 200 })
  })

  it('a lone 200 (single probe) still maps to 200 -- the IO layer is what retries', () => {
    expect(reduceConflictProbes([{ conflicted: false, status: 200 }])).toEqual({ conflicted: false, status: 200 })
  })

  it('mixed non-200 / network errors are inconclusive (status 0)', () => {
    expect(reduceConflictProbes([
      { conflicted: false, status: 200 },
      { conflicted: false, status: 0 },
    ])).toEqual({ conflicted: false, status: 0 })
    expect(reduceConflictProbes([
      { conflicted: false, status: 500 },
      { conflicted: false, status: 0 },
    ])).toEqual({ conflicted: false, status: 0 })
  })

  it('empty result set is inconclusive', () => {
    expect(reduceConflictProbes([])).toEqual({ conflicted: false, status: 0 })
  })
})

// ---------------------------------------------------------------------------
// shouldEscalate -- 2-cycle threshold + one-alert-per-outage anti-spam
// ---------------------------------------------------------------------------

describe('shouldEscalate', () => {
  it('does not escalate before the threshold (default 2 cycles)', () => {
    expect(shouldEscalate(0, false)).toBe(false)
    expect(shouldEscalate(1, false)).toBe(false)
  })

  it('escalates at the threshold when not yet alerted', () => {
    expect(shouldEscalate(2, false)).toBe(true)
    expect(shouldEscalate(3, false)).toBe(true)
  })

  it('never escalates twice for the same outage (anti-spam)', () => {
    expect(shouldEscalate(2, true)).toBe(false)
    expect(shouldEscalate(9, true)).toBe(false)
  })

  it('respects a custom threshold', () => {
    expect(shouldEscalate(2, false, 3)).toBe(false)
    expect(shouldEscalate(3, false, 3)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// nextState -- pure state transitions across cycles
// ---------------------------------------------------------------------------

describe('nextState', () => {
  const NOW = 1_700_000_000_000

  it('healthy resets the dead counter, clears the alert, and stamps lastHealthyTs', () => {
    const prev: WatchdogState = { consecutiveDead: 4, alerted: true, lastHealthyTs: null }
    expect(nextState(prev, 'healthy', NOW)).toEqual({ consecutiveDead: 0, alerted: false, lastHealthyTs: NOW })
  })

  it('dead increments the consecutive counter and preserves the alert flag', () => {
    const prev: WatchdogState = { consecutiveDead: 1, alerted: false, lastHealthyTs: 123 }
    expect(nextState(prev, 'dead', NOW)).toEqual({ consecutiveDead: 2, alerted: false, lastHealthyTs: 123 })
  })

  it('dead keeps an already-set alert flag (no re-alert mid-outage)', () => {
    const prev: WatchdogState = { consecutiveDead: 3, alerted: true, lastHealthyTs: 123 }
    expect(nextState(prev, 'dead', NOW)).toEqual({ consecutiveDead: 4, alerted: true, lastHealthyTs: 123 })
  })

  it('inconclusive leaves the state completely untouched (fail-safe)', () => {
    const prev: WatchdogState = { consecutiveDead: 2, alerted: true, lastHealthyTs: 99 }
    expect(nextState(prev, 'inconclusive', NOW)).toBe(prev)
  })

  it('INITIAL_STATE is a clean zero state', () => {
    expect(INITIAL_STATE).toEqual({ consecutiveDead: 0, alerted: false, lastHealthyTs: null })
  })

  it('a full dead -> dead -> recover cycle reaches escalation exactly once', () => {
    let s = { ...INITIAL_STATE }
    s = nextState(s, 'dead', NOW) // cycle 1
    expect(shouldEscalate(s.consecutiveDead, s.alerted)).toBe(false)
    s = nextState(s, 'dead', NOW) // cycle 2 -> threshold
    expect(shouldEscalate(s.consecutiveDead, s.alerted)).toBe(true)
    s = { ...s, alerted: true } // cycle 2 sends the one alert
    s = nextState(s, 'dead', NOW) // cycle 3 still dead
    expect(shouldEscalate(s.consecutiveDead, s.alerted)).toBe(false) // no second alert
    s = nextState(s, 'healthy', NOW) // recovered -> reset
    expect(s).toEqual({ consecutiveDead: 0, alerted: false, lastHealthyTs: NOW })
  })
})

// ---------------------------------------------------------------------------
// formatRecoveryEvent -- provable, parseable log line
// ---------------------------------------------------------------------------

describe('formatRecoveryEvent', () => {
  it('emits an ISO-timestamped, tab-separated line', () => {
    const line = formatRecoveryEvent({ ts: 1_700_000_000_000, kind: 'drop-detected', detail: 'consecutiveDead=1' })
    const [iso, kind, detail] = line.split('\t')
    expect(iso).toBe(new Date(1_700_000_000_000).toISOString())
    expect(kind).toBe('drop-detected')
    expect(detail).toBe('consecutiveDead=1')
  })
})

// ---------------------------------------------------------------------------
// Source contracts -- structural guarantees about the IO layer
// ---------------------------------------------------------------------------

const SRC = readFileSync(join(__dirname, '../web/telegram-pipe-watchdog.ts'), 'utf-8')

describe('telegram-pipe-watchdog -- source contracts', () => {
  it('reuses the tested /mcp recovery primitive (does not reinvent menu nav)', () => {
    expect(SRC).toMatch(/attemptChannelMcpReconnect/)
  })

  it('uses the 409-conflict probe as the authoritative liveness signal', () => {
    expect(SRC).toMatch(/probeTelegramConflict/)
  })

  it('checks process presence as a secondary signal', () => {
    expect(SRC).toMatch(/probeChannelPollerPresence/)
  })

  it('sends the fallback alert via a direct Bot API call, NOT the dead pipe', () => {
    expect(SRC).toMatch(/api\.telegram\.org\/bot\$\{token\}\/sendMessage/)
  })

  it('persists state across separate 5-minute process invocations', () => {
    expect(SRC).toMatch(/telegram-pipe-watchdog\.state\.json/)
  })

  it('appends a recovery-event log for provable behaviour', () => {
    expect(SRC).toMatch(/telegram-pipe-watchdog\.log/)
  })
})
