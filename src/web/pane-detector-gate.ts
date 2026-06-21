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
import { PROJECT_ROOT, ALLOWED_CHAT_ID } from '../config.js'
import { sendTelegramMessage } from './telegram.js'

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

// Mismatch versions already alerted on this server lifetime. One Telegram alert
// per mismatch version is enough -- the fleet-supervisor.sh already fires one at
// detection time; this catches the case where the server restarts into a
// pre-existing drift where the supervisor won't re-alert.
const alertedMismatchVersions = new Set<string>()

// Injectable for tests; default reads TELEGRAM_BOT_TOKEN from the root .env and
// sends via Bot API directly (pipe-independent: the MCP pipe may be dead when a
// CLI drift occurs, which is precisely when the alert is most needed).
export type DriftAlertFn = (reason: string, mismatchVersion: string) => Promise<void>

async function defaultDriftAlert(reason: string, mismatchVersion: string): Promise<void> {
  const envContent = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8')
  const tokenMatch = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/)
  const token = tokenMatch?.[1]?.trim()
  if (!token || !ALLOWED_CHAT_ID.trim()) {
    logger.warn({ mismatchVersion }, 'pane-detector drift alert suppressed: no TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID')
    return
  }
  const text = [
    `[Marveen] Claude CLI drift eszlelve: ${mismatchVersion}`,
    `A pane-fuggo watchdogok LEALLTAK amig a c12 pane-detektor smoke el nem fut az uj CLI-n.`,
    `Futtatsd: tsx scripts/pane-detector-smoke-clear.ts -- ez ujraengedi a watchdogokat.`,
    `Reszlet: ${reason}`,
  ].join('\n')
  await sendTelegramMessage(token, ALLOWED_CHAT_ID, text)
}

let _driftAlertFn: DriftAlertFn = defaultDriftAlert

/** Override the drift-alert sender (test seam). */
export function __setDriftAlertFn(fn: DriftAlertFn): void {
  _driftAlertFn = fn
}

/** Reset module-level state between tests (test seam only). */
export function __resetPaneGateState(): void {
  lastTrustedByWatchdog.clear()
  alertedMismatchVersions.clear()
  _driftAlertFn = defaultDriftAlert
}

/**
 * Gate check for a pane-dependent watchdog. Returns true when the watchdog may
 * proceed. Logs only when the trust state CHANGES for that watchdog, so a
 * sustained stand-down does not flood the log. On the first stand-down per
 * mismatch version, fires a direct Bot API Telegram alert (pipe-independent).
 * Call at the top of the sweep:
 *   if (!checkPaneDetectorGate('stuck-input')) return
 */
export function checkPaneDetectorGate(label: string): boolean {
  const mismatchVersion = readTrimmedOrNull(paneDetectorMismatchFile()) ?? ''
  const { trusted, reason } = readPaneDetectorGate()
  const prev = lastTrustedByWatchdog.get(label)
  if (prev !== trusted) {
    lastTrustedByWatchdog.set(label, trusted)
    if (!trusted) {
      logger.warn({ watchdog: label, reason }, 'pane-detector gate: watchdog standing down (CLI drift, smoke pending)')
      // Send a direct Bot API alert once per mismatch version so the operator
      // knows watchdogs are offline even when the Telegram MCP pipe is down.
      if (mismatchVersion && !alertedMismatchVersions.has(mismatchVersion)) {
        alertedMismatchVersions.add(mismatchVersion)
        _driftAlertFn(reason, mismatchVersion).catch((err) => {
          logger.warn({ err, mismatchVersion }, 'pane-detector drift Telegram alert failed (non-fatal)')
        })
      }
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
