// Cross-source SessionStart continuity-budget accumulator (memory-continuity
// Phase 1, S3 hardening -- card 7126a3df).
//
// PROBLEM: the per-source caps (ledger ~16k, checkpoint ~4k, memory ~2k) are
// enforced independently. The dedup path (checkpoint->ledger suppression
// marker) keeps the happy path within ~5-6k, but in a degenerate case
// (reversed hook order OR marker-write failure) BOTH windows can inject,
// pushing the combined SessionStart inject to ~8k.
//
// HARDENING: this module provides a HARD cross-source runtime clamp. Each
// hook calls POST /api/agent-continuity-budget/:agent/claim before emitting
// its additionalContext. The accumulator enforces a single combined budget
// across all three sources (checkpoint, ledger, memory) so the SessionStart
// inject is deterministically bounded regardless of hook order and marker
// success.
//
// DESIGN CHOICES:
//   - In-memory only (no DB): the budget is per-boot, lives for one SessionStart
//     event (~seconds), and is never durability-critical. An in-memory map is
//     the right tool.
//   - Boot-window grouping: hooks don't share an explicit bootId. We group all
//     claims within BOOT_WINDOW_MS (10s) of the first claim for a given agent
//     as one boot. After the window the slot is fresh for the next boot.
//   - Fail-open: if the endpoint is unavailable the hooks fall back to their
//     per-source caps (the existing behavior) -- no degradation vs. today.
//   - Re-entrant safe: the accumulator is a plain Map; Node.js event loop
//     serializes requests (no concurrent mutation of a single agent slot).

// Combined hard cap. The goal is "within ~5-6k on the happy path, never over
// 8k even in the degenerate case". We set the hard cap at 8000 chars -- any
// source that would push the combined total over this limit is refused.
export const COMBINED_CONTINUITY_BUDGET = 8000

// A "boot window": claims by the same agent within this many milliseconds of
// the first claim are treated as belonging to the same SessionStart boot and
// draw from the same combined budget. After the window expires the slot is
// automatically reset for the next boot.
export const BOOT_WINDOW_MS = 10_000

// Allow up to this many stale (past-window) slots to accumulate before we
// sweep; keeps the map bounded without a timer.
const SWEEP_THRESHOLD = 50

export interface BudgetSlot {
  bootStartMs: number
  usedChars: number
  sources: Set<string>
}

// Exported for tests (DI / inspection).
export type BudgetMap = Map<string, BudgetSlot>

// Module-level singleton (the real accumulator).
const _budgetMap: BudgetMap = new Map()

// Sanitize an agent name to the same safe charset as agent-checkpoint.ts.
function sanitize(agent: string): string {
  return agent.replace(/[^a-zA-Z0-9_-]/g, '')
}

function sweep(map: BudgetMap, nowMs: number): void {
  if (map.size < SWEEP_THRESHOLD) return
  for (const [key, slot] of map) {
    if (nowMs - slot.bootStartMs > BOOT_WINDOW_MS) map.delete(key)
  }
}

/**
 * Try to claim `chars` characters of combined SessionStart budget for `source`
 * on behalf of `agent`. Returns `{ allowed: boolean, remaining: number }`.
 *
 * - If the agent has no active boot slot (or its slot expired), opens a new
 *   boot window for this agent.
 * - A source may only claim once per boot window. A repeat claim from the same
 *   source (idempotent retry) is accepted and counts as the SAME slot entry
 *   (the chars are added only once).
 * - Fail-closed on the budget: if granting the claim would push usedChars
 *   over COMBINED_CONTINUITY_BUDGET the claim is refused (allowed=false) and
 *   the used total is NOT incremented.
 * - `remaining` is always COMBINED_CONTINUITY_BUDGET - usedChars BEFORE the
 *   claim, so the caller can truncate to fit if it chooses.
 *
 * Injectable map (default = module singleton) purely for isolated unit tests.
 */
export function claimContinuityBudget(
  agent: string,
  source: string,
  chars: number,
  nowMs: number,
  map: BudgetMap = _budgetMap,
): { allowed: boolean; remaining: number; usedAfter: number } {
  const key = sanitize(agent)
  sweep(map, nowMs)

  const existing = map.get(key)
  const isNewBoot = !existing || (nowMs - existing.bootStartMs > BOOT_WINDOW_MS)
  const slot: BudgetSlot = isNewBoot
    ? { bootStartMs: nowMs, usedChars: 0, sources: new Set() }
    : existing
  if (isNewBoot) map.set(key, slot)

  const remaining = Math.max(0, COMBINED_CONTINUITY_BUDGET - slot.usedChars)

  // Idempotent: if this source already claimed this boot, do nothing extra.
  // This handles a double-fire (e.g. a hook that retries on the same boot).
  if (slot.sources.has(source)) {
    return { allowed: true, remaining, usedAfter: slot.usedChars }
  }

  if (slot.usedChars + chars > COMBINED_CONTINUITY_BUDGET) {
    // Claim refused: the budget is exhausted. The source is NOT added to the
    // set so a future retry with fewer chars could still succeed.
    return { allowed: false, remaining, usedAfter: slot.usedChars }
  }

  slot.usedChars += chars
  slot.sources.add(source)
  return { allowed: true, remaining, usedAfter: slot.usedChars }
}

/**
 * Reset the budget slot for `agent` (used in tests and explicit clear calls).
 */
export function resetContinuityBudget(agent: string, map: BudgetMap = _budgetMap): void {
  map.delete(sanitize(agent))
}

/**
 * Inspect the current slot for `agent` (read-only, used in tests).
 */
export function inspectContinuityBudget(
  agent: string,
  map: BudgetMap = _budgetMap,
): BudgetSlot | undefined {
  return map.get(sanitize(agent))
}
