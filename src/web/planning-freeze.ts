import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

// Server-side mirror of the planning-freeze gate in scripts/fleet-supervisor.sh
// (planning_freeze_enabled / freeze_keep_ids / freeze_blocks).
//
// WHY THIS EXISTS (lesson: planning-freeze-server-respawn-leak, 2026-10-13):
// the shell supervisor's freeze gate governs only the *watchdog* layer. The
// dashboard server (this process) independently reconciles the fleet back to
// agents-desired.json -- reconcileDesiredAgents() plus the channel-monitor
// recovery respawns -- with no knowledge of the freeze flag. So a planning
// freeze "leaked": agents the operator killed were resurrected by the server
// within ~17s (direct `claude --continue`, no watchdog involved). Killing them
// was whack-a-mole: 13 came back inside 5 minutes.
//
// This module gives the server the SAME gate, reading the SAME two files, with
// the SAME fail-safe semantics, so there is ONE conceptual freeze contract
// across both layers. Like the shell, it gates the AUTOMATIC self-heal paths
// only; explicit operator/infra launches pass { force: true } and bypass it --
// mirroring the shell, whose gate stops watchdogs but never a manual launch.
//
// FAIL-SAFE DIRECTION: when anything is uncertain (flag unreadable, keep-file
// unreadable) the gate ALLOWS. An over-eager block would wrongly suppress a
// keep-list agent; the shell chose the same direction ("flag absent => allow =>
// exact current behavior"). The one deliberate divergence from the shell is the
// degenerate all-comments keep-file: the shell yields an empty keep-list (which
// would block even claudia/hibiki), we fall back to the default keep-list. The
// live keep-file is never empty, so this never changes behavior in practice --
// it only removes a latent foot-gun.

// Paths are computed lazily inside the fs wrappers (not at module load) so that
// merely importing this module has no side effect -- a module-load read of
// STORE_DIR breaks tests that partially mock ../config.js, and an undefined
// STORE_DIR here would throw before the fail-safe try/catch could catch it.
const freezeFlagPath = (): string => join(STORE_DIR, 'planning-freeze.enabled')
const keepFilePath = (): string => join(STORE_DIR, 'planning-freeze-keep.txt')

// Default keep-list, identical to the shell fallback in freeze_keep_ids().
// marveen (orchestrator / channels session) and infra agents (dashboard, n8n,
// medic, pipe watchdogs) are not sub-agents started through startAgentProcess,
// so they never reach this gate regardless of the keep-list.
export const DEFAULT_KEEP: readonly string[] = ['claudia', 'hibiki']

// --- Pure core (filesystem-free, unit-testable) ------------------------------

/**
 * Parse a keep-file's contents exactly like the shell freeze_keep_ids():
 * one id per line, blank lines and '#'-comment lines ignored, first
 * whitespace-delimited token of each remaining line taken as the id.
 * null / unreadable / empty-after-filtering -> DEFAULT_KEEP.
 */
export function parseKeepList(contents: string | null): Set<string> {
  if (contents == null) return new Set(DEFAULT_KEEP)
  const ids = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split(/\s+/)[0])
    .filter((id): id is string => !!id)
  return ids.length > 0 ? new Set(ids) : new Set(DEFAULT_KEEP)
}

/**
 * Pure block decision. Mirrors the shell freeze_blocks():
 * block iff the freeze flag is set AND the id is NOT in the keep-list.
 * enabled=false => always allow (the fail-safe / current behavior).
 */
export function freezeBlocksWith(enabled: boolean, keepIds: Set<string>, name: string): boolean {
  if (!enabled) return false
  return !keepIds.has(name)
}

// --- Filesystem wrappers -----------------------------------------------------

/** True iff store/planning-freeze.enabled exists. Mirrors planning_freeze_enabled(). */
export function planningFreezeEnabled(): boolean {
  try {
    return existsSync(freezeFlagPath())
  } catch {
    return false // fail-safe: uncertain -> treat as no freeze
  }
}

/** Agent ids allowed to run during a freeze. Mirrors freeze_keep_ids(). */
export function freezeKeepIds(): Set<string> {
  try {
    const path = keepFilePath()
    if (!existsSync(path)) return new Set(DEFAULT_KEEP)
    return parseKeepList(readFileSync(path, 'utf-8'))
  } catch {
    return new Set(DEFAULT_KEEP) // fail-safe: unreadable -> default keep-list
  }
}

/**
 * freezeBlocks(name): true = block this agent's AUTOMATIC (re)spawn; false = allow.
 * Explicit operator/infra launches must bypass by not calling this (force).
 */
export function freezeBlocks(name: string): boolean {
  const enabled = planningFreezeEnabled()
  if (!enabled) return false
  const blocked = freezeBlocksWith(true, freezeKeepIds(), name)
  if (blocked) {
    logger.info({ agent: name }, 'planning-freeze: automatic (re)spawn suppressed (not in keep-list)')
  }
  return blocked
}
