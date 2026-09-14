import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import {
  classifyLastBoot,
  readShutdownMarker,
  stampCleanShutdown,
  consumeShutdownMarker,
  classifyAndConsume,
  SHUTDOWN_MARKER_TTL_MS,
  type ShutdownMarker,
} from '../web/shutdown-marker.js'

const NOW = 1_700_000_000_000
const marker = (over: Partial<ShutdownMarker> = {}): ShutdownMarker => ({ ts: NOW, clean: true, ...over })

// Path is computed here (not exported) to exercise corrupt/absent reads directly.
const markerFile = (agent: string) =>
  join(PROJECT_ROOT, 'store', 'agent-checkpoints', `${agent}.shutdown`)

// Pure-fn coverage is the safety core: nothing reads this classification until
// S2, so classifyLastBoot must be exhaustively correct before the gate uses it.
describe('classifyLastBoot', () => {
  it("absent marker => 'crash' (previous session never stamped a clean end)", () => {
    expect(classifyLastBoot(null, NOW)).toBe('crash')
  })
  it("present + clean + fresh => 'clean'", () => {
    expect(classifyLastBoot(marker(), NOW + 1000)).toBe('clean')
  })
  it("clean at the TTL boundary is still 'clean'", () => {
    expect(classifyLastBoot(marker(), NOW + SHUTDOWN_MARKER_TTL_MS)).toBe('clean')
  })
  it("clean beyond the TTL degrades to 'unknown' (too old to trust)", () => {
    expect(classifyLastBoot(marker(), NOW + SHUTDOWN_MARKER_TTL_MS + 1)).toBe('unknown')
  })
  it("present but clean:false => 'crash' (defensive; we only ever write clean:true)", () => {
    expect(classifyLastBoot(marker({ clean: false }), NOW + 1)).toBe('crash')
  })
  it("NaN ts => 'unknown' (malformed marker)", () => {
    expect(classifyLastBoot(marker({ ts: NaN }), NOW)).toBe('unknown')
  })
  it("non-finite ts => 'unknown'", () => {
    expect(classifyLastBoot(marker({ ts: Infinity }), NOW)).toBe('unknown')
  })
})

// I/O round-trip on the real store dir, with cleanup.
describe('shutdown-marker store I/O', () => {
  const A = 'vitest-shutdown-agent'
  afterEach(() => consumeShutdownMarker(A))

  it('stampCleanShutdown -> readShutdownMarker round-trips {ts, clean:true}', () => {
    stampCleanShutdown(A, NOW)
    const m = readShutdownMarker(A)!
    expect(m.clean).toBe(true)
    expect(m.ts).toBe(NOW)
  })

  it('absent marker reads as null (=> crash)', () => {
    consumeShutdownMarker(A)
    expect(readShutdownMarker(A)).toBeNull()
    expect(classifyLastBoot(readShutdownMarker(A), NOW)).toBe('crash')
  })

  it("a present-but-corrupt marker reads as malformed (=> 'unknown', not a false crash)", () => {
    stampCleanShutdown(A, NOW) // create the dir + file
    writeFileSync(markerFile(A), '{ this is not json')
    const m = readShutdownMarker(A)
    expect(m).not.toBeNull()
    expect(classifyLastBoot(m, NOW)).toBe('unknown')
  })

  it('classifyAndConsume returns the verdict AND deletes the marker', () => {
    stampCleanShutdown(A, NOW)
    expect(classifyAndConsume(A, NOW + 1)).toBe('clean')
    expect(readShutdownMarker(A)).toBeNull() // consumed
  })

  // THE key behavior: a consumed clean marker cannot mask a later crash.
  it('clean -> consume -> crash: an unstamped session end reads as crash next boot', () => {
    // session 1 ends cleanly
    stampCleanShutdown(A, NOW)
    // session 2 startup: reads clean, consumes it
    expect(classifyAndConsume(A, NOW + 1000)).toBe('clean')
    // session 2 CRASHES -> no stampCleanShutdown call
    // session 3 startup: absence is now correctly a crash, not a stale 'clean'
    expect(classifyAndConsume(A, NOW + 2000)).toBe('crash')
  })

  it('sanitizes the agent name (no path traversal in the filename)', () => {
    stampCleanShutdown('../../etc/passwd', NOW)
    const m = readShutdownMarker('../../etc/passwd')
    expect(m).not.toBeNull()
    consumeShutdownMarker('../../etc/passwd')
  })
})
