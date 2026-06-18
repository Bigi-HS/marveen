// Pane-detector trust gate (card 56ad0fa3 / B1+B4). The pane-state detector
// (the BUSY_INDICATORS regexes in pane-state.ts) is coupled to how the Claude
// Code CLI renders a pane. When the CLI version changes, the detector MIGHT
// mis-read a pane, which would make the pane-dependent wedge watchdogs
// (stuck-input, stuck-tool-call, wedged-queue) act on a false reading -- nudging
// or recovering a perfectly healthy agent. Until a c12 pane-detector smoke
// confirms the detector still reads the new CLI correctly, those watchdogs must
// STAND DOWN.
//
// This turns the prior alert-only drift notice (the "mandatory c12 smoke
// required" Telegram message) into an ENFORCED barrier (B4). It is file-
// coordinated across the three processes that touch it:
//   - fleet-supervisor.sh cli-version-watch writes the mismatch file (the new
//     CLI version) when `claude --version` drifts from its stored baseline.
//   - the pane watchdogs call checkPaneDetectorGate() at the top of each sweep
//     and skip (logging only on a state change) while the gate is UNTRUSTED.
//   - the c12 pane-detector smoke, once it passes on the new CLI, calls
//     recordPaneDetectorSmokePass(version) -- writes the smoke-passed file and
//     removes the mismatch file -- re-enabling the watchdogs.
//
// ANTI-PATTERN (card): do NOT auto-clear the gate by silently bumping the
// baseline to current. Only a passed smoke (human/c12) re-enables it; otherwise
// a CLI drift that breaks the detector would be hidden, which is worse than the
// old hardcoded baseline constant.

import { readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { logger } from '../logger.js'
import { atomicWriteFileSync } from './atomic-write.js'

// Paths are resolved lazily (per call, off MARVEEN_ROOT) rather than frozen at
// import, so a test can point MARVEEN_ROOT at a tmpdir and the c12 smoke CLI and
// the dashboard agree on the same files regardless of cwd. They live in the
// supervisor's state dir next to its claude-cli-version.txt baseline.
function stateDir(): string {
  return join(process.env.MARVEEN_ROOT ?? process.cwd(), 'store', '.fleet-supervisor')
}

/** The new CLI version that triggered a drift, written by the supervisor. */
export function paneDetectorMismatchFile(): string {
  return join(stateDir(), 'cli-version-mismatch.txt')
}

/** The CLI version the pane-detector smoke last passed on, written by the smoke. */
export function paneDetectorSmokePassedFile(): string {
  return join(stateDir(), 'cli-smoke-passed.txt')
}

export interface PaneDetectorGateStatus {
  trusted: boolean
  reason: string
}

/**
 * Pure gate decision. TRUSTED unless a CLI drift is flagged that the
 * pane-detector smoke has not yet re-validated:
 *   - no mismatch flagged            -> trusted (steady state; no smoke needed).
 *   - mismatch flagged, smoke==drift -> trusted (smoke re-validated the new CLI).
 *   - mismatch flagged, smoke stale  -> NOT trusted (watchdogs stand down).
 * Whitespace is trimmed; empty/absent values read as null. No IO.
 */
export function paneDetectorGateStatus(
  mismatchVersion: string | null,
  smokePassedVersion: string | null,
): PaneDetectorGateStatus {
  const drift = (mismatchVersion ?? '').trim()
  if (!drift) return { trusted: true, reason: 'no CLI drift flagged' }
  const smoke = (smokePassedVersion ?? '').trim()
  if (smoke && smoke === drift) {
    return { trusted: true, reason: `pane-detector smoke passed for CLI ${drift}` }
  }
  return {
    trusted: false,
    reason: `CLI drift to ${drift}; pane-detector smoke not yet passed (last smoke: ${smoke || 'none'})`,
  }
}

function readTrimmedOrNull(path: string): string | null {
  try {
    const v = readFileSync(path, 'utf-8').trim()
    return v.length > 0 ? v : null
  } catch {
    return null
  }
}

/** Read both state files and compute the current gate status. */
export function readPaneDetectorGate(): PaneDetectorGateStatus {
  return paneDetectorGateStatus(
    readTrimmedOrNull(paneDetectorMismatchFile()),
    readTrimmedOrNull(paneDetectorSmokePassedFile()),
  )
}

// Per-watchdog memory of the last trusted state, so a stand-down / re-enable is
// logged once on transition instead of every sweep (the watchdogs tick on a few
// seconds).
const lastTrustedByWatchdog = new Map<string, boolean>()

/**
 * Gate check for a pane-dependent watchdog. Returns true when the watchdog may
 * proceed. Logs only when the trust state CHANGES for that watchdog, so a
 * sustained stand-down does not flood the log. Call at the top of the sweep:
 *   if (!checkPaneDetectorGate('stuck-input')) return
 */
export function checkPaneDetectorGate(label: string): boolean {
  const { trusted, reason } = readPaneDetectorGate()
  const prev = lastTrustedByWatchdog.get(label)
  if (prev !== trusted) {
    lastTrustedByWatchdog.set(label, trusted)
    if (!trusted) {
      logger.warn({ watchdog: label, reason }, 'pane-detector gate: watchdog standing down (CLI drift, smoke pending)')
    } else if (prev !== undefined) {
      logger.info({ watchdog: label, reason }, 'pane-detector gate: watchdog re-enabled (smoke passed)')
    }
  }
  return trusted
}

/**
 * Record that the pane-detector smoke PASSED on `version` and clear the drift
 * gate: write the smoke-passed file and remove the mismatch file, so the
 * watchdogs re-enable. Called by the c12 pane-detector smoke / its clear CLI.
 * Atomic write so a crash mid-record cannot leave a torn version.
 */
export function recordPaneDetectorSmokePass(version: string): void {
  const v = version.trim()
  if (!v) throw new Error('recordPaneDetectorSmokePass: empty version')
  const passedFile = paneDetectorSmokePassedFile()
  mkdirSync(dirname(passedFile), { recursive: true })
  atomicWriteFileSync(passedFile, v + '\n')
  try {
    rmSync(paneDetectorMismatchFile())
  } catch {
    // mismatch file already absent -- fine, the smoke-passed record is what matters.
  }
}
