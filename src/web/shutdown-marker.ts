import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'

// Per-agent clean-shutdown-vs-crash marker (memory-continuity Phase 1, S1).
//
// Boss #1 (2026-09-14): an agent that CRASHES loses its pre-crash context. A
// crash presents at the next SessionStart as an ordinary cold `startup`, so
// without a signal we cannot tell a crash-restart (should resume the in-flight
// task) from a normal fresh boot (should NOT). This module supplies exactly
// that bit, PER AGENT -- agent sessions are separate Claude Code processes, so a
// server-side (dashboard) marker could not gate per-agent replay.
//
// Protocol:
//   - a NEW SessionEnd hook calls stampCleanShutdown() on a normal session end
//     -> writes store/agent-checkpoints/<agent>.shutdown = {ts, clean:true}.
//   - at the next SessionStart(=startup) the consumer reads the marker, derives
//     classifyLastBoot(), and CONSUMES it (deletes) so a stale clean marker can
//     never mask a LATER crash. If THIS session then crashes, no clean marker is
//     written, so the following startup sees ABSENCE = crash.
//
// S1 ships this module + the SessionEnd stamp only (ZERO read-side behavior).
// The SessionStart read/consume + the replay gate land together in S2, so the
// marker is never read until the moment its verdict is used -- the crash-masking
// invariant holds from the first read. Fail-open throughout: a marker
// write/read/delete failure is caught + logged, never thrown into the agent turn.

const MARKER_DIR = join(PROJECT_ROOT, 'store', 'agent-checkpoints')

// A clean marker is at most one session old under normal operation (consumed at
// the next startup). The TTL is only a defensive backstop for a marker that
// somehow outlived its consume: a stale clean marker degrades to 'unknown', not
// a confident 'clean'. 'unknown' and 'clean' both suppress replay in S2, so the
// exact value is not safety-critical; 7d comfortably covers a weekend-idle agent.
export const SHUTDOWN_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type BootClass = 'clean' | 'crash' | 'unknown'

export interface ShutdownMarker {
  ts: number     // epoch ms, written at SessionEnd
  clean: boolean // true == a normal session end stamped this
}

function sanitizeAgent(agent: string): string {
  // The agent name becomes a filename -- allow only the safe charset.
  return agent.replace(/[^a-zA-Z0-9_-]/g, '')
}

function markerPath(agent: string): string {
  return join(MARKER_DIR, `${sanitizeAgent(agent)}.shutdown`)
}

/**
 * PURE classification of the last boot from the marker left (or not) by the
 * previous session.
 *   - absent (null) => 'crash': the previous session never stamped a clean end.
 *     Safe because S2 additionally requires a fresh, unconsumed, non-empty
 *     task-state before it resumes anything, so a first-boot false-'crash'
 *     resumes nothing.
 *   - present + clean:true + within TTL => 'clean'.
 *   - present + clean:false => 'crash' (defensive; we only ever write true).
 *   - stale (beyond TTL) or malformed (non-finite ts) => 'unknown'.
 * 'clean' and 'unknown' both suppress replay downstream; only 'crash' resumes.
 */
export function classifyLastBoot(
  marker: ShutdownMarker | null,
  nowMs: number,
  ttlMs: number = SHUTDOWN_MARKER_TTL_MS,
): BootClass {
  if (!marker) return 'crash'
  if (typeof marker.ts !== 'number' || !Number.isFinite(marker.ts)) return 'unknown'
  if (nowMs - marker.ts > ttlMs) return 'unknown'
  return marker.clean === true ? 'clean' : 'crash'
}

/**
 * Read the marker left by the previous session.
 *   - absent -> null (the caller classifies absence as 'crash').
 *   - present but corrupt -> {ts:NaN} so classifyLastBoot yields 'unknown', NOT
 *     a false 'crash' (a garbage file still means "something was here").
 */
export function readShutdownMarker(agent: string): ShutdownMarker | null {
  const path = markerPath(agent)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ShutdownMarker>
    return {
      ts: typeof raw.ts === 'number' ? raw.ts : NaN,
      clean: raw.clean === true,
    }
  } catch (err) {
    logger.warn({ err, agent }, 'shutdown-marker: unreadable marker (treated as unknown)')
    return { ts: NaN, clean: false }
  }
}

/** Stamp a clean shutdown. Called by the SessionEnd hook. Fail-open. */
export function stampCleanShutdown(agent: string, nowMs: number): void {
  try {
    if (!existsSync(MARKER_DIR)) mkdirSync(MARKER_DIR, { recursive: true })
    const marker: ShutdownMarker = { ts: nowMs, clean: true }
    atomicWriteFileSync(markerPath(agent), JSON.stringify(marker))
  } catch (err) {
    logger.warn({ err, agent }, 'shutdown-marker: clean-stamp write failed (fail-open)')
  }
}

/** Delete the marker after a SessionStart read so it cannot mask a later crash. */
export function consumeShutdownMarker(agent: string): void {
  const path = markerPath(agent)
  try { if (existsSync(path)) unlinkSync(path) } catch { /* best effort */ }
}

/**
 * Convenience for the SessionStart consumer (wired in S2): read + classify +
 * consume in one call. The marker is deleted so the next boot's absence reads
 * as a crash. Kept out of the LIVE path until S2.
 */
export function classifyAndConsume(
  agent: string,
  nowMs: number,
  ttlMs: number = SHUTDOWN_MARKER_TTL_MS,
): BootClass {
  const verdict = classifyLastBoot(readShutdownMarker(agent), nowMs, ttlMs)
  consumeShutdownMarker(agent)
  return verdict
}
