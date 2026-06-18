// Identity-binding decisions (card b1ce5118, design e7cf5444 §5.2-5.4).
//
// Pure decision helpers that the route layer and the auth gate consume. Kept
// free of http/db plumbing so the authorization logic -- the security-critical
// part -- is exhaustively unit-testable in isolation.
//
// Two enforcement points ship here, BOTH gated behind one env flag so the whole
// Tier-1 enforcement flips atomically and reversibly at rollout (C-BIND), never
// piecemeal:
//   - decideMessageFrom    : POST /api/messages `from` must equal the token id
//                            (gap b -- impersonation).
//   - decideMemoryMutation : DELETE/PUT /api/memories owner-only (gap a).
//
// The flag (ENFORCE_FROM_BINDING) defaults OFF: with it off, both helpers return
// the legacy outcome, so b1ce5118 lands INERT on the live fleet. The flag is
// read ONLY from the process environment, NEVER from a request body or header
// (Chad #5): a compromised admin-scope agent must not be able to disable
// enforcement over the API.

import { sanitizeAgentIdent } from '../prompt-safety.js'
import {
  hasScope,
  safeResolveAgentIdentity,
  ADMIN_SCOPE,
  type AgentIdentity,
} from './agent-token-registry.js'
import type Database from 'better-sqlite3'

// The curator scope that lets a non-owner mutate another agent's memory
// (Applegate's dedup/tiering role -- design §5.3).
const MEMORY_CURATE_SCOPE = 'memory:delete:any'

const TRUTHY = new Set(['on', '1', 'true', 'yes'])

// Is from_agent / owner enforcement on? ENV-ONLY by design (Chad #5). `env` is
// injectable for tests; production passes process.env.
export function enforceFromBindingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has((env.ENFORCE_FROM_BINDING ?? '').trim().toLowerCase())
}

// The mandatory startup log line (Chad #5): emitted once at boot so an operator
// can SEE whether enforcement is live. Without this, an env-less restart would
// silently disable enforcement with no signal. Grepped verbatim by the test.
export function fromBindingStatusLine(enabled: boolean): string {
  return `[auth] from_agent enforcement: ${enabled ? 'ON' : 'OFF'}`
}

export type FromDecision = { ok: true; from: string } | { ok: false; status: number; error: string }

// Decide the effective `from_agent` for an inter-agent message.
//   flag OFF        -> legacy: trust the body `from` verbatim.
//   admin/operator  -> may impersonate (the body `from` stands; e.g. NoA relays
//                      a message as another agent).
//   agent + match   -> allowed; `from` pinned to the token id (so a missing or
//                      decorated `from` is derived, not rejected).
//   agent + mismatch -> 403.
// Normalization uses sanitizeAgentIdent so it agrees with the message router's
// matching (and keeps the existing @coordinator bypass class closed).
export function decideMessageFrom(
  identity: AgentIdentity,
  bodyFrom: string | undefined,
  enforce: boolean,
): FromDecision {
  if (!enforce) return { ok: true, from: bodyFrom ?? '' }
  if (hasScope(identity.scopes, ADMIN_SCOPE)) return { ok: true, from: bodyFrom ?? identity.agentId }
  const claimed = sanitizeAgentIdent(bodyFrom ?? '')
  const self = sanitizeAgentIdent(identity.agentId)
  if (!claimed || claimed === self) return { ok: true, from: identity.agentId }
  return { ok: false, status: 403, error: 'from must match the authenticated agent identity' }
}

export type MutationDecision = { ok: true } | { ok: false; status: number; error: string }

// Authorize a memory mutation (DELETE/PUT) against the row's owner.
//   flag OFF              -> legacy: always allowed (inert).
//   admin OR curator scope -> allowed for any owner.
//   owner === token id    -> allowed (own memory).
//   otherwise             -> 403.
export function decideMemoryMutation(
  identity: AgentIdentity,
  ownerAgentId: string,
  enforce: boolean,
): MutationDecision {
  if (!enforce) return { ok: true }
  if (hasScope(identity.scopes, ADMIN_SCOPE)) return { ok: true }
  if (hasScope(identity.scopes, MEMORY_CURATE_SCOPE)) return { ok: true }
  if (ownerAgentId === identity.agentId) return { ok: true }
  return { ok: false, status: 403, error: 'not authorized to modify this memory' }
}

export interface GateInput {
  hasSession: boolean
  bearer: string | undefined
  db: Database.Database
  sharedToken: string
  now: number
  // True for a mutation (POST/PUT/DELETE/PATCH). Drives the expired-token split:
  // expired -> writes fail closed, reads stay permissive (design §5.7).
  isWrite: boolean
}

export type GateResult = { pass: true; identity: AgentIdentity } | { pass: false; status: number }

// Compose the auth-gate decision: resolve the request to an identity, applying
// the expired-token read/write split. A valid browser session is the operator
// identity (the UI is operator-privileged) without a registry read. Everything
// else routes through the fail-closed registry resolver.
export function resolveRequestIdentity(input: GateInput): GateResult {
  const { hasSession, bearer, db, sharedToken, now, isWrite } = input
  if (hasSession) {
    return { pass: true, identity: { agentId: 'marveen', scopes: [ADMIN_SCOPE], source: 'operator' } }
  }
  const r = safeResolveAgentIdentity(db, bearer, sharedToken, now)
  if (r.kind === 'ok') return { pass: true, identity: r.identity }
  if (r.kind === 'expired') {
    // Writes fail closed; reads stay permissive during migration but carry no
    // scopes, so an expired token authenticates a GET yet authorizes nothing.
    if (isWrite) return { pass: false, status: 401 }
    return { pass: true, identity: { agentId: r.agentId, scopes: [], source: 'agent' } }
  }
  return { pass: false, status: 401 }
}
