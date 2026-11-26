// Inter-agent delegation loop/depth guard (card 3e80e203, DA G-02).
//
// A delegation chain (NoA->Armorer->NoA ...) could otherwise run silently with no
// depth bound -- token-burn + kanban-spam, no timeout, no mechanism to stop it.
// Every inter-agent message carries a SERVER-DERIVED delegation_depth: a root
// (Boss/user/scheduled, no triggering inbound) is depth 0; a message sent in
// response to an inbound parent is parent.delegation_depth + 1. At
// depth >= DELEGATION_DEPTH_LIMIT the insert is DECLINED and the Boss is escalated
// once (alert-false-alarm-audit: only a real limit hit).
//
// Anti-spoofing (spec §2.2 / AC2): the depth is NEVER read from the client payload.
// The client may only supply a delegation_parent_id (a reference to a real inbound
// row); the server recomputes the depth from that parent's stored depth. A client
// that lies "delegation_depth=0" on a deep chain cannot shrink the derived value.
//
// Fail-safe / assertion-direction (spec §2.2, assertion-direction-check): the guard
// must assert on the DANGEROUS side -- a runaway cycle MUST stop. So when a parent
// is referenced but its row cannot be resolved (missing/broken chain, derivation
// uncertain), the conservative depth is NOT 0 (which would let an infinite chain
// run) -- it is the LIMIT, so the guard fires and the chain halts.

import { DELEGATION_DEPTH_LIMIT } from '../config.js'
import { getAgentMessage } from '../db.js'
import { logger } from '../logger.js'
import { defaultDeliver, type AlertDeliver } from './operator-alert.js'

export const DELEGATION_DEPTH_EXCEEDED = 'delegation_depth_exceeded'

export interface DepthDerivation {
  depth: number
  parentId: number | null
}

/**
 * Derive the delegation depth for a new message from its (optional) parent linkage.
 *
 * - No parent (root: Boss/user/scheduled-task) -> depth 0, parentId null.
 * - Parent present and resolvable -> parent.delegation_depth + 1.
 * - Parent present but UNRESOLVABLE -> depth = limit (fail-safe DANGEROUS side:
 *   the guard fires, the chain stops; never silently default to 0).
 *
 * `limit` is injected so the fail-safe tracks the same bound the guard enforces.
 */
export function deriveDelegationDepth(
  parentId: number | null | undefined,
  limit: number = DELEGATION_DEPTH_LIMIT,
  lookup: (id: number) => { delegation_depth?: number } | undefined = getAgentMessage,
): DepthDerivation {
  if (parentId === null || parentId === undefined) {
    return { depth: 0, parentId: null }
  }
  const parent = lookup(parentId)
  if (!parent) {
    // Broken/missing parent chain: do NOT assume a root (depth 0) -- that is the
    // false-negative that lets a cycle run forever. Clamp to the limit so the
    // guard declines and the chain halts (fail-safe on the dangerous side).
    logger.warn({ parentId, limit }, 'delegation-depth: parent message not found; failing safe at limit')
    return { depth: limit, parentId }
  }
  // delegation_depth is NOT NULL DEFAULT 0 in the schema; coalesce defensively so a
  // pre-migration/partially-read row (undefined) is treated as a root parent, never
  // as a negative that could under-count.
  const parentDepth = Number.isInteger(parent.delegation_depth) ? (parent.delegation_depth as number) : 0
  return { depth: parentDepth + 1, parentId }
}

/** True when the derived depth has reached/exceeded the configured limit. */
export function isDelegationDepthExceeded(depth: number, limit: number = DELEGATION_DEPTH_LIMIT): boolean {
  return depth >= limit
}

// Escalate seam. Injected in tests so a unit test never sends a real Telegram
// message; defaults to the shared operator-alert delivery path. Mirrors the
// pattern used by missed-fire-alert / pending-retry-alert.
let escalateDeliver: AlertDeliver = defaultDeliver

/** Test seam: override the Boss-escalation delivery. Returns the previous one. */
export function _setDelegationEscalateDeliver(deliver: AlertDeliver): AlertDeliver {
  const prev = escalateDeliver
  escalateDeliver = deliver
  return prev
}

/**
 * Escalate a real limit hit to the Boss (halt-style notify). Fired ONLY when a
 * chain genuinely reaches the limit -- not on every deep chain -- so it does not
 * cry wolf (alert-false-alarm-audit, AC4). Delivery failure is non-fatal: the
 * decline has already stopped the chain; the alert is best-effort evidence.
 */
export async function escalateDelegationDepth(args: {
  from: string
  to: string
  depth: number
  limit: number
  parentId: number | null
}): Promise<void> {
  const { from, to, depth, limit, parentId } = args
  logger.warn(
    { from, to, depth, limit, parentId },
    'delegation-depth: LIMIT reached -- declining insert and escalating to Boss (possible delegation loop)',
  )
  const text =
    `🛑 Delegation depth limit reached (possible loop)\n` +
    `from=${from} to=${to}\n` +
    `depth=${depth} (limit ${limit}), parent_message_id=${parentId ?? 'n/a'}\n` +
    `The message was DECLINED (not inserted); the delegation chain is halted.`
  try {
    await escalateDeliver(text)
  } catch (err) {
    logger.warn({ err }, 'delegation-depth: Boss escalation delivery failed (non-fatal; chain already halted)')
  }
}
