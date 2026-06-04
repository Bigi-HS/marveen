import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { shouldRecoverStalledQueue } from '../web/channel-monitor.js'
import { readLastAssistantTimestamp } from '../web/inbound-probe.js'

// --- Pure stall decision -------------------------------------------------
// Stall = inbound ingested but no assistant turn advanced past it for longer
// than the threshold. The defaults below mirror channel-monitor.ts constants.
const STALL = 10 * 60 * 1000
const COLD_START = 6 * 60 * 1000
const BACKOFF = 30 * 60 * 1000
const base = {
  stallThresholdMs: STALL,
  respawnGraceMs: COLD_START,
  stallBackoffMs: BACKOFF,
  msSinceLastMainRespawn: null as number | null,
  msSinceLastStallRecovery: null as number | null,
}

describe('shouldRecoverStalledQueue', () => {
  it('fires on the incident timeline: inbound queued, last assistant turn hours earlier', () => {
    // 2026-06-03: last real activity 13:45, Dominik msg ingested 22:14, checked 22:30.
    const lastProgressTs = new Date('2026-06-03T13:45:24Z').getTime()
    const lastInboundTs = new Date('2026-06-03T22:14:00Z').getTime()
    const nowMs = new Date('2026-06-03T22:30:00Z').getTime()
    expect(shouldRecoverStalledQueue({ ...base, lastInboundTs, lastProgressTs, nowMs })).toBe(true)
  })

  it('fires when no assistant turn has EVER run since the inbound (lastProgress null)', () => {
    const lastInboundTs = 1_000_000
    expect(shouldRecoverStalledQueue({
      ...base, lastInboundTs, lastProgressTs: null, nowMs: lastInboundTs + STALL + 1,
    })).toBe(true)
  })

  it('does not fire when there is no inbound at all', () => {
    expect(shouldRecoverStalledQueue({
      ...base, lastInboundTs: null, lastProgressTs: 5, nowMs: 10 ** 12,
    })).toBe(false)
  })

  it('does not fire when the agent already progressed past the inbound', () => {
    const lastInboundTs = 1_000_000
    expect(shouldRecoverStalledQueue({
      ...base, lastInboundTs, lastProgressTs: lastInboundTs + 1, nowMs: lastInboundTs + STALL + 1,
    })).toBe(false)
  })

  it('treats an exactly-equal progress timestamp as already-answered (not a stall)', () => {
    const lastInboundTs = 1_000_000
    expect(shouldRecoverStalledQueue({
      ...base, lastInboundTs, lastProgressTs: lastInboundTs, nowMs: lastInboundTs + STALL + 1,
    })).toBe(false)
  })

  it('does not fire while the inbound is still inside the stall threshold (legit long turn)', () => {
    const lastInboundTs = 1_000_000
    expect(shouldRecoverStalledQueue({
      ...base, lastInboundTs, lastProgressTs: null, nowMs: lastInboundTs + STALL - 1,
    })).toBe(false)
  })

  it('defers while a recent respawn is still in its cold-start window', () => {
    const lastInboundTs = 1_000_000
    expect(shouldRecoverStalledQueue({
      ...base, lastInboundTs, lastProgressTs: null, nowMs: lastInboundTs + STALL + 1,
      msSinceLastMainRespawn: COLD_START - 1,
    })).toBe(false)
  })

  it('acts once the cold-start window has elapsed', () => {
    const lastInboundTs = 1_000_000
    expect(shouldRecoverStalledQueue({
      ...base, lastInboundTs, lastProgressTs: null, nowMs: lastInboundTs + STALL + 1,
      msSinceLastMainRespawn: COLD_START + 1,
    })).toBe(true)
  })

  it('does not hammer: defers within the 30-min stall-recovery backoff (429/no-token guard)', () => {
    const lastInboundTs = 1_000_000
    expect(shouldRecoverStalledQueue({
      ...base, lastInboundTs, lastProgressTs: null, nowMs: lastInboundTs + STALL + 1,
      msSinceLastStallRecovery: BACKOFF - 1,
    })).toBe(false)
  })

  it('retries once the backoff has elapsed', () => {
    const lastInboundTs = 1_000_000
    expect(shouldRecoverStalledQueue({
      ...base, lastInboundTs, lastProgressTs: null, nowMs: lastInboundTs + STALL + 1,
      msSinceLastStallRecovery: BACKOFF + 1,
    })).toBe(true)
  })
})

// --- Transcript progress reader -----------------------------------------
describe('readLastAssistantTimestamp', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null }
  })

  function writeTranscript(lines: object[]): string {
    dir = mkdtempSync(join(tmpdir(), 'stall-transcript-'))
    writeFileSync(join(dir, 'session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    return dir
  }

  it('returns the timestamp of the last assistant entry, ignoring user/queue/system lines', () => {
    const d = writeTranscript([
      { type: 'assistant', timestamp: '2026-06-03T10:00:00Z', message: {} },
      { type: 'user', timestamp: '2026-06-03T11:00:00Z', message: { content: '<channel source="telegram">hi</channel>' } },
      { type: 'queue-operation', timestamp: '2026-06-03T11:05:00Z', operation: 'enqueue' },
      { type: 'assistant', timestamp: '2026-06-03T10:30:00Z', message: {} },
      { type: 'system', timestamp: '2026-06-03T12:00:00Z', subtype: 'info' },
    ])
    expect(readLastAssistantTimestamp(d)).toBe(new Date('2026-06-03T10:30:00Z').getTime())
  })

  it('returns null when the transcript has no assistant entries', () => {
    const d = writeTranscript([
      { type: 'user', timestamp: '2026-06-03T11:00:00Z', message: {} },
      { type: 'queue-operation', timestamp: '2026-06-03T11:05:00Z', operation: 'enqueue' },
    ])
    expect(readLastAssistantTimestamp(d)).toBeNull()
  })

  it('returns null when the directory does not exist', () => {
    expect(readLastAssistantTimestamp(join(tmpdir(), 'no-such-dir-stall-test-xyz'))).toBeNull()
  })
})
