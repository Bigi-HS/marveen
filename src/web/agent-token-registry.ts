// Per-agent dashboard-bearer registry (card b1ce5118, design e7cf5444 §5.1-5.2).
//
// The dashboard has always gated every /api/* route behind ONE shared bearer
// (dashboard-auth.ts). That makes the caller un-attributable: the server sees a
// valid shared token and a self-asserted body field, so any agent can act as any
// other. This module adds a registry mapping a presented bearer to a concrete
// `{ agentId, scopes }` identity, so the server can DERIVE who is calling from
// the credential instead of trusting a body field.
//
// SECRET HANDLING: the registry stores ONLY sha256(token), never the plaintext
// (the raw token is surfaced once at mint time to the launch helper and then
// lives only in that agent's 0600 env). This mirrors how gate-db.ts and the
// session layer treat at-rest state: every function takes an explicit `db` so
// the route layer passes the live singleton while tests run on :memory:.
//
// The shared token stays registered IMPLICITLY as the operator/admin identity
// (marveen, admin:*) -- the backward-compat anchor, so nothing using the shared
// token today changes behaviour. Per-agent scoping is additive on top.

import type Database from 'better-sqlite3'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// The implicit identity of the shared dashboard token / browser session. The
// operator is `marveen` with the admin sentinel so the existing operator
// scripts and the NoA-as-another-agent relay keep working unchanged.
export const OPERATOR_AGENT_ID = 'marveen'
// The admin sentinel. NOT a runtime wildcard: it is an exact literal scope whose
// presence in a token's scope set grants every check (see hasScope). The `:*` is
// a label, expanded to the concrete admin capability at the hasScope boundary,
// never pattern-matched against the *required* scope.
export const ADMIN_SCOPE = 'admin:*'
export const OPERATOR_SCOPES: readonly string[] = [ADMIN_SCOPE]

export interface AgentIdentity {
  agentId: string
  scopes: string[]
  // 'operator' = the shared dashboard token / browser session (admin);
  // 'agent'    = a registered per-agent token.
  source: 'operator' | 'agent'
}

// Resolution outcome. `expired` is split out from `unknown` so the gate can keep
// expired-token GETs working during migration while failing expired-token writes
// closed (design §5.7); `unknown` is always a hard 401.
export type ResolveResult =
  | { kind: 'ok'; identity: AgentIdentity }
  | { kind: 'expired'; agentId: string }
  | { kind: 'unknown' }

// Additive migration: pure CREATE TABLE IF NOT EXISTS + indexes. Idempotent on
// every boot, references no other table (no FK), so it can never break boot or
// trip an FK-enforced rebuild. token_sha256 is UNIQUE -- a hash collision or a
// double-mint of the same plaintext is rejected at the DB layer.
export function migrateAgentTokenTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id     TEXT NOT NULL,
      token_sha256 TEXT NOT NULL UNIQUE,
      scopes_json  TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER,
      revoked_at   INTEGER
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tokens_sha ON agent_tokens(token_sha256)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tokens_agent ON agent_tokens(agent_id)`)
}

// sha256 hex of a presented bearer. The registry key.
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export interface MintResult {
  // The raw token -- surfaced ONCE to the caller (the mint/launch path), never
  // persisted. Treat as a secret: never log it.
  token: string
  tokenSha256: string
  expiresAt: number | null
}

export interface MintOptions {
  now?: number
  // Absolute lifetime in ms. Omit for a non-expiring token.
  ttlMs?: number
}

// Mint a fresh per-agent token (32 random bytes, like the shared token),
// register sha256(token) -> {agentId, scopes, expiry}, and return the raw token
// to the caller exactly once.
export function mintAgentToken(
  db: Database.Database,
  agentId: string,
  scopes: string[],
  opts: MintOptions = {},
): MintResult {
  const now = opts.now ?? Date.now()
  const token = randomBytes(32).toString('hex')
  const tokenSha256 = hashToken(token)
  const expiresAt = opts.ttlMs != null ? now + opts.ttlMs : null
  db.prepare(
    `INSERT INTO agent_tokens (agent_id, token_sha256, scopes_json, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(agentId, tokenSha256, JSON.stringify(scopes), now, expiresAt)
  return { token, tokenSha256, expiresAt }
}

// Constant-time equality for the shared-token compare (mirrors checkBearerToken
// in dashboard-auth.ts -- length-guard first, then timingSafeEqual).
function tokenEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

interface TokenRow {
  agent_id: string
  scopes_json: string
  expires_at: number | null
  revoked_at: number | null
}

// Resolve a presented bearer to an identity. Order:
//   1. exact match of the shared token -> operator/admin (no registry read).
//   2. sha256 lookup in the registry: not found / revoked -> unknown;
//      expired -> expired; otherwise -> the agent identity + scopes.
// NOTE: this may throw if the DB read fails -- callers that must fail closed on
// an infrastructure error use safeResolveAgentIdentity below.
export function resolveAgentIdentity(
  db: Database.Database,
  bearer: string | undefined,
  sharedToken: string,
  now: number = Date.now(),
): ResolveResult {
  if (!bearer) return { kind: 'unknown' }
  if (tokenEquals(bearer, sharedToken)) {
    return { kind: 'ok', identity: { agentId: OPERATOR_AGENT_ID, scopes: [...OPERATOR_SCOPES], source: 'operator' } }
  }
  const row = db
    .prepare('SELECT agent_id, scopes_json, expires_at, revoked_at FROM agent_tokens WHERE token_sha256 = ?')
    .get(hashToken(bearer)) as TokenRow | undefined
  if (!row) return { kind: 'unknown' }
  if (row.revoked_at != null) return { kind: 'unknown' } // revoked is a hard 401, never its old identity
  if (row.expires_at != null && now >= row.expires_at) return { kind: 'expired', agentId: row.agent_id }
  let scopes: string[]
  try {
    const parsed = JSON.parse(row.scopes_json)
    scopes = Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    scopes = [] // a corrupt scope blob is default-deny, not default-open
  }
  return { kind: 'ok', identity: { agentId: row.agent_id, scopes, source: 'agent' } }
}

// Fail-closed wrapper (design §5.2 invariant 3): if identity resolution itself
// errors (e.g. a registry read failure), return `unknown` (-> 401) -- NEVER
// pass-through-as-admin or pass-through-unscoped. This is the one place we fail
// closed on an infrastructure error, distinct from the launch-availability
// fail-open, because here we already hold a request to authorize.
export function safeResolveAgentIdentity(
  db: Database.Database,
  bearer: string | undefined,
  sharedToken: string,
  now: number = Date.now(),
): ResolveResult {
  try {
    return resolveAgentIdentity(db, bearer, sharedToken, now)
  } catch {
    return { kind: 'unknown' }
  }
}

// Mark every still-live token of an agent revoked (on-demand revoke, or the
// revoke half of a revoke+remint rotation). Returns the number revoked. The
// revoked rows stay until pruned past expiry, mirroring the session revocation
// pattern in dashboard-auth.ts.
//
// INCIDENT RESPONSE (DA FLAG 3): on a *suspected token compromise*, call this --
// revocation is immediate (revoked -> 401). Do NOT rely on the 24h expiry to
// "age out" a leaked token: expiry is a blast-radius bound for the normal cycle,
// not an IR control, and an expired token still passes GET reads (scopeless)
// during migration. Compromise => revoke now, then remint.
export function revokeAgentTokens(db: Database.Database, agentId: string, now: number = Date.now()): number {
  return db
    .prepare('UPDATE agent_tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL')
    .run(now, agentId).changes
}

// Drop rows whose absolute expiry has passed. A non-expiring token (expires_at
// NULL) is never pruned. Returns the number removed.
export function pruneExpiredTokens(db: Database.Database, now: number = Date.now()): number {
  return db
    .prepare('DELETE FROM agent_tokens WHERE expires_at IS NOT NULL AND expires_at < ?')
    .run(now).changes
}

// Scope check -- EXACT membership only (design §5.2 invariant 1). Never a
// prefix / startsWith / regex match: a token holding `memory:delete` must NOT
// satisfy `memory:delete:any`. The admin sentinel is honoured as an exact
// literal in the token's scope set (admin may do anything), which is itself a
// membership test, not a wildcard expansion of the *required* scope.
// Empty / absent scope sets are default-deny (invariant 2).
export function hasScope(scopes: string[] | null | undefined, required: string): boolean {
  if (!Array.isArray(scopes) || scopes.length === 0) return false
  if (scopes.includes(ADMIN_SCOPE)) return true
  return scopes.includes(required)
}
