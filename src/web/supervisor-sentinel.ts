import { spawn, execFileSync } from 'node:child_process'
import { existsSync, openSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { createAgentMessage } from '../db.js'
import { notifyChannel } from '../notify.js'

// "Who watches the watcher." fleet-supervisor.sh keeps the dashboard, channels
// and every agent watchdog alive, but nothing keeps IT alive once booted: its
// only (re)launcher is fleet-boot.sh on WSL boot. The 2026-06-09 deploy showed
// it can die mid-session (external kill -- no exit/signal/OOM logged), after
// which thor/chad/hibiki + the agent watchdogs run unprotected until a reboot
// or a manual restart. That is a single point of failure.
//
// This sentinel closes the loop the OTHER way: the dashboard (the most reliable
// always-up, reboot-persistent process, and itself relaunched by the supervisor)
// pgreps for the supervisor every minute and relaunches it -- setsid-detached,
// as fleet-boot does -- when it is gone, and emits a LOUD inter-agent alert so
// the silent death becomes visible. Mutual supervision, no infinite regress:
// if BOTH die at once only a reboot/fleet-boot recovers (rare, documented).
//
// A single death self-heals quietly (relaunch + inter-agent alert to marveen,
// which works even if marveen's Telegram pipe is down). But a CRASH-LOOP (the
// supervisor won't stay up, so the sentinel cannot heal it) is a real
// "need-human" state: after MAX_RELAUNCH_PER_WINDOW failed attempts we STOP
// hammering and escalate LOUDLY straight to Dominik via the channel (bypassing
// the inter-agent hop), throttled so we do not spam him.
//
// Prereq: the flock fd-leak fix (card 09fa76f2) -- a cleanly-dead supervisor
// frees its lock so this relaunch acquires it instead of exiting "lock held".

const SUPERVISOR = join(PROJECT_ROOT, 'scripts', 'fleet-supervisor.sh')
const LOG_FILE = join(PROJECT_ROOT, 'store', 'fleet-supervisor.log')
// Armorer writes this file before a planned restart and removes it after verify.
// While it is fresh the single-relaunch alert is suppressed (still relaunched)
// so a real unexpected crash still stands out. TTL: 30 min; an stale marker is
// treated as absent so a forgotten file cannot permanently silence alerts.
export const PLANNED_RESTART_MARKER = join(PROJECT_ROOT, 'store', 'planned-restart.marker')
const PLANNED_RESTART_MARKER_TTL_MS = 30 * 60 * 1_000
const INITIAL_DELAY_MS = 60_000
const INTERVAL_MS = 60_000
const MIN_RELAUNCH_INTERVAL_MS = 120_000   // floor between relaunch attempts
const RELAUNCH_WINDOW_MS = 3_600_000        // sliding 1h crash-loop window
const MAX_RELAUNCH_PER_WINDOW = 5           // attempts in the window before escalating
const ESCALATION_THROTTLE_MS = 3_600_000    // direct-to-Dominik alert at most 1/h

export type SentinelAction = 'noop' | 'relaunch' | 'escalate'

interface DecideOpts {
  minIntervalMs?: number
  windowMs?: number
  maxPerWindow?: number
}

// --- pure decision (unit-tested) -------------------------------------------

export function pruneStamps(stamps: number[], nowMs: number, windowMs: number): number[] {
  return stamps.filter((s) => nowMs - s < windowMs)
}

// Decide what to do this tick from the supervisor's liveness and the recent
// relaunch history. 'escalate' once the crash-loop cap is hit (stop relaunching,
// shout for a human); 'relaunch' for a fresh/occasional death; 'noop' while
// healthy or within the per-attempt backoff.
export function decideAction(
  running: boolean,
  stamps: number[],
  nowMs: number,
  opts: DecideOpts = {},
): SentinelAction {
  if (running) return 'noop'
  const minIntervalMs = opts.minIntervalMs ?? MIN_RELAUNCH_INTERVAL_MS
  const windowMs = opts.windowMs ?? RELAUNCH_WINDOW_MS
  const maxPerWindow = opts.maxPerWindow ?? MAX_RELAUNCH_PER_WINDOW
  const recent = pruneStamps(stamps, nowMs, windowMs)
  if (recent.length >= maxPerWindow) return 'escalate'
  const last = recent.length ? Math.max(...recent) : null
  if (last !== null && nowMs - last < minIntervalMs) return 'noop'
  return 'relaunch'
}

// --- module state ----------------------------------------------------------

let relaunchStamps: number[] = []
let lastEscalationMs: number | null = null

// --- IO --------------------------------------------------------------------

// True when a fresh planned-restart marker is present (written by Armorer before
// a deploy restart, deleted after verify). A stale marker (>30 min) is ignored
// so a forgotten file cannot permanently silence unexpected-death alerts.
export function isPlannedRestartWindow(): boolean {
  try {
    if (!existsSync(PLANNED_RESTART_MARKER)) return false
    return Date.now() - statSync(PLANNED_RESTART_MARKER).mtimeMs < PLANNED_RESTART_MARKER_TTL_MS
  } catch {
    return false
  }
}

// True if a fleet-supervisor.sh process is alive. pgrep -f matches process
// cmdlines; the node dashboard's own cmdline is `node dist/index.js`, so it
// never self-matches, and pgrep excludes its own pid by design.
export function supervisorRunning(): boolean {
  try {
    const out = execFileSync('pgrep', ['-f', 'scripts/fleet-supervisor\\.sh'], {
      timeout: 5_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim().length > 0
  } catch {
    // pgrep exits 1 when there is no match -> not running.
    return false
  }
}

// Relaunch the supervisor setsid-detached, mirroring fleet-boot.sh
// (`nohup bash scripts/fleet-supervisor.sh >> store/fleet-supervisor.log 2>&1`).
// detached:true makes the child a new session leader (setsid), so a later
// dashboard restart never orphans or kills the supervisor it started.
function relaunchSupervisor(): void {
  const fd = openSync(LOG_FILE, 'a')
  try {
    const child = spawn('/bin/bash', [SUPERVISOR], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    child.unref()
  } finally {
    // The child dup'd the fd for its stdout/stderr; close our copy so it is not
    // leaked into this long-lived dashboard process.
    closeSync(fd)
  }
}

// Quiet self-heal path: works even when marveen's Telegram pipe is down.
function alertMarveen(message: string): void {
  try {
    createAgentMessage('supervisor-sentinel', MAIN_AGENT_ID, message)
  } catch (err) {
    logger.warn({ err }, 'supervisor-sentinel: failed to emit inter-agent alert')
  }
}

// Loud, human-targeted path for the crash-loop / relaunch-failure case: goes
// straight to the operator channel (bypasses the inter-agent hop). Also mirrors
// to marveen so the record exists either way. Never logs the token.
function escalateToDominik(message: string): void {
  notifyChannel(message).catch((err) => logger.error({ err }, 'supervisor-sentinel: channel escalation failed'))
  alertMarveen(message)
}

function sweep(): void {
  if (process.env['SUPERVISOR_SENTINEL_DISABLED'] === '1') return
  if (!existsSync(SUPERVISOR)) return

  const now = Date.now()

  if (supervisorRunning()) {
    // Healthy (or recovered): clear incident state so a future death starts a
    // fresh window and can escalate again if needed.
    if (relaunchStamps.length || lastEscalationMs !== null) {
      relaunchStamps = []
      lastEscalationMs = null
      logger.info('supervisor-sentinel: supervisor healthy again, incident state reset')
    }
    return
  }

  const action = decideAction(false, relaunchStamps, now)

  if (action === 'relaunch') {
    const planned = isPlannedRestartWindow()
    try {
      relaunchSupervisor()
      relaunchStamps = pruneStamps([...relaunchStamps, now], now, RELAUNCH_WINDOW_MS)
      if (planned) {
        // Suppress the inter-agent alert: this is a known Armorer deploy restart.
        // The relaunch still runs so the supervisor is back fast; the quiet log
        // line is enough for post-deploy audit. A real crash sets planned=false
        // (marker absent or expired) and the loud path fires normally.
        logger.info('supervisor-sentinel: fleet-supervisor.sh briefly down -- planned restart window, relaunched silently')
      } else {
        logger.warn('supervisor-sentinel: fleet-supervisor.sh was DOWN -- relaunched (setsid-detached)')
        alertMarveen('FIGYELEM: a fleet-supervisor.sh nem futott -- a dashboard sentinel ujrainditotta (setsid-detached). Nezd meg miert allt le (kulso kill?); a friss indulas a store/fleet-supervisor.log-ban.')
      }
    } catch (err) {
      // A relaunch that throws is severe: shout directly at the operator regardless
      // of the planned-restart window -- a failed relaunch always needs human eyes.
      logger.error({ err }, 'supervisor-sentinel: relaunch FAILED')
      relaunchStamps = pruneStamps([...relaunchStamps, now], now, RELAUNCH_WINDOW_MS)
      escalateToDominik('SULYOS: a fleet-supervisor.sh nem futott ES a dashboard sentinel relaunch-a HIBAZOTT. Manualis beavatkozas kell a hoston.')
    }
    return
  }

  if (action === 'escalate') {
    // Crash-loop: cap exhausted, the sentinel cannot heal it. Stop hammering;
    // escalate to Dominik directly, throttled.
    if (lastEscalationMs === null || now - lastEscalationMs >= ESCALATION_THROTTLE_MS) {
      lastEscalationMs = now
      logger.error('supervisor-sentinel: supervisor CRASH-LOOPING (relaunch cap exhausted) -- escalating to operator')
      escalateToDominik(`SULYOS: a fleet-supervisor.sh ismetelten lehal (${MAX_RELAUNCH_PER_WINDOW}+ relaunch egy oran belul nem maradt fent). A sentinel leallt a relaunch-csal, manualis beavatkozas kell. Az agens-watchdogok addig orizet nelkul futnak.`)
    } else {
      logger.warn('supervisor-sentinel: supervisor still down (crash-loop), escalation throttled -- not relaunching')
    }
    return
  }
  // 'noop': down but within the per-attempt backoff; wait for the next tick.
}

export function startSupervisorSentinel(): NodeJS.Timeout {
  setTimeout(sweep, INITIAL_DELAY_MS)
  const interval = setInterval(sweep, INTERVAL_MS)
  if (typeof interval.unref === 'function') interval.unref()
  return interval
}
