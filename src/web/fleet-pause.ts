// Fleet-pause sentinel (card fd30873b, P2 -- the "actual pause" state machine).
//
// When the rate-limit governor crosses the threshold it writes a pause sentinel
// here; on resume it clears it. The sentinel is the single source of truth for
// "is the fleet paused, and until when". It is deliberately INERT on its own:
// this module only writes/reads the state. The ENFORCEMENT -- the supervisor /
// scheduled-task runner / per-agent nudges actually honouring isFleetPaused()
// and holding off -- is a SEPARATE, Boss-gated live-activation step (the #50/#81
// pattern: build + gate + dry-run the mechanism first, wire the live blast-radius
// second). So merging this module pauses NOTHING by itself: no consumer reads it
// yet. That is intentional and keeps the merge blast-radius at zero.
//
// Pure-ish: all IO is fail-safe (a missing/corrupt sentinel reads as "not
// paused"), so a sentinel problem can never wedge a caller.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

export const FLEET_PAUSE_PATH = join(PROJECT_ROOT, 'store', '.fleet-paused.json')

export interface FleetPauseRecord {
  // epoch seconds the pause was declared, and the epoch seconds at/after which
  // the fleet may resume (governor's reset + grace).
  pausedAt: number
  resumeAt: number
  // the five-hour usage pct that triggered it, and a short human reason.
  pct: number | null
  reason: string
}

function isRecord(v: unknown): v is FleetPauseRecord {
  return (
    !!v && typeof v === 'object' &&
    typeof (v as FleetPauseRecord).pausedAt === 'number' &&
    typeof (v as FleetPauseRecord).resumeAt === 'number'
  )
}

// Read the current sentinel, or null when absent/corrupt (fail-safe = not paused).
export function readFleetPause(path: string = FLEET_PAUSE_PATH): FleetPauseRecord | null {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Declare a fleet pause (atomic). Overwrites any prior sentinel.
export function writeFleetPause(record: FleetPauseRecord, path: string = FLEET_PAUSE_PATH): void {
  try {
    atomicWriteFileSync(path, JSON.stringify(record), { mode: 0o600 })
  } catch {
    /* best-effort: a missed write just means no sentinel; the governor re-acts next cycle */
  }
}

// Clear the pause (resume). Idempotent: clearing a missing sentinel is a no-op.
export function clearFleetPause(path: string = FLEET_PAUSE_PATH): void {
  try {
    rmSync(path, { force: true })
  } catch {
    /* best-effort */
  }
}

// True iff a sentinel exists AND now is before its resumeAt. A sentinel whose
// resumeAt has passed reads as NOT paused (self-expiring), so a crashed governor
// that never cleared the sentinel cannot strand the fleet paused forever.
export function isFleetPaused(nowSec: number, path: string = FLEET_PAUSE_PATH): boolean {
  const rec = readFleetPause(path)
  return rec !== null && nowSec < rec.resumeAt
}
