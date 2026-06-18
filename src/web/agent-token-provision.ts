// Per-agent token provisioning (card b1ce5118, design e7cf5444 §5.5-5.6).
//
// Composes the DB registry (agent-token-registry) with the on-disk token file
// the launch helper (scripts/lib/agent-token-env.sh) reads. Called at agent
// launch: it revokes the agent's prior live tokens, mints a fresh one, and
// writes the two-line token file (raw token + absolute expiry in epoch seconds)
// atomically at 0600. The raw token exists only between mint and the file write;
// it is never logged.
//
// WRITE-side symlink safety (Chad #4): atomicWriteFileSync writes a temp file in
// the target dir and rename(2)s it into place. POSIX rename replaces a symlink
// at the destination with the real file rather than following it, so a planted
// symlink cannot redirect this write -- the read-side guard in the launch helper
// covers the converse (reading through a planted symlink).
//
// PARENT-DIR symlink safety (DA FLAG 1): rename(2) only protects the FINAL path
// component. If the parent directory itself is a symlink (e.g. agents/dave ->
// agents/marveen, planted before the agent's first launch), the atomic write
// would follow it and clobber another agent's token file. We lstat the parent
// and refuse to write through a symlinked directory rather than follow it. This
// covers the immediate parent; a symlinked *ancestor* (agents/ itself) requires
// write access to the fleet root, which already grants direct token overwrite --
// out of the Tier-1 single-user threat model (design §5.5 note).

import { mkdirSync, lstatSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteFileSync } from './atomic-write.js'
import { mintAgentToken, revokeAgentTokens, ADMIN_SCOPE } from './agent-token-registry.js'
import type Database from 'better-sqlite3'

// 24h default (design §5.6): short enough to bound the blast-radius of a stolen
// token, re-minted on the normal daily relaunch cycle. Overridable so the
// rollout can tune it (open decision §8.5).
export const DEFAULT_AGENT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

// The baseline capability set every agent gets (design §5.3). Coarse and few --
// not a full RBAC.
export const STANDARD_AGENT_SCOPES: readonly string[] = [
  'message:send',
  'memory:write:own',
  'memory:delete:own',
  'dailylog:write:own',
]

// Scope assignment per agent (design §5.3). marveen is the operator/admin;
// applegate is the memory curator (cross-agent delete). Everyone else gets the
// owner-bound standard set.
export function scopesForAgent(agentId: string): string[] {
  if (agentId === 'marveen') return [ADMIN_SCOPE]
  if (agentId === 'applegate') return [...STANDARD_AGENT_SCOPES, 'memory:delete:any']
  return [...STANDARD_AGENT_SCOPES]
}

export interface ProvisionOptions {
  now?: number
  ttlMs?: number
}

export interface ProvisionResult {
  tokenSha256: string
  expiresAt: number | null
  scopes: string[]
}

// Serialize the token file the launch helper consumes: line 1 the raw token,
// line 2 the absolute expiry in epoch SECONDS (empty when non-expiring). Seconds
// (not ms) so the bash helper compares against `date +%s` without math.
function serializeTokenFile(token: string, expiresAt: number | null): string {
  const expirySeconds = expiresAt != null ? String(Math.floor(expiresAt / 1000)) : ''
  return `${token}\n${expirySeconds}\n`
}

// Mint + persist a fresh token for an agent and write its 0600 token file.
// Revokes the agent's prior live tokens first (clean rotation -- one live token
// per agent). `tokenFile` is the absolute path the launch helper will read.
export function provisionAgentToken(
  db: Database.Database,
  agentId: string,
  tokenFile: string,
  opts: ProvisionOptions = {},
): ProvisionResult {
  const now = opts.now ?? Date.now()
  const ttlMs = opts.ttlMs ?? DEFAULT_AGENT_TOKEN_TTL_MS
  const scopes = scopesForAgent(agentId)
  // Rotate: kill any previous live token so only the freshly-minted one resolves.
  revokeAgentTokens(db, agentId, now)
  const { token, tokenSha256, expiresAt } = mintAgentToken(db, agentId, scopes, { now, ttlMs })
  const tokenDir = dirname(tokenFile)
  mkdirSync(tokenDir, { recursive: true })
  // Parent-dir symlink guard (DA FLAG 1): refuse to write through a symlinked
  // directory rather than follow it into another agent's token file.
  if (lstatSync(tokenDir).isSymbolicLink()) {
    throw new Error(
      `agent-token-provision: refusing to write ${tokenFile}: parent directory ${tokenDir} is a symlink`,
    )
  }
  atomicWriteFileSync(tokenFile, serializeTokenFile(token, expiresAt), { mode: 0o600 })
  return { tokenSha256, expiresAt, scopes }
}
