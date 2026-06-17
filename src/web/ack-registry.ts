// ACK-capability V2 -- runtime registry persistence (card 83b7ec10).
//
// V1 read a static `ackCapable: true` flag from agent-config.json. V2 replaces
// that with a runtime registry: each agent self-declares capability at boot (via
// a SessionStart hook -> POST /api/agents/:id/ack-declare). The router reads ONLY
// this table, so capability is self-healing -- a restarted agent re-declares, one
// that was never deployed with the hook stays fail-closed automatically.
//
// Two bugs from the reverted pre-spec V2 are structurally avoided here:
//  1. The declaration write is UNCONDITIONAL -- it does NOT gate on the static
//     V1 flag, so the registry can diverge from the flag (the no-op fix).
//  2. The capability read is registry-only; the launcher plays no part (the
//     watchdog-launch false-negative is fixed by the SessionStart hook, which
//     fires regardless of which launch path created the tmux session).
//
// See store/specs/ack-capability-v2.md.

import type Database from 'better-sqlite3'

// TTL bounds (seconds). The endpoint clamps caller-supplied values into this
// range so a misconfigured hook (e.g. ttl_seconds:0) cannot make an agent
// permanently incapable or capable-forever.
export const ACK_TTL_MIN = 3600 // 1h floor
export const ACK_TTL_MAX = 604800 // 7d cap
export const ACK_TTL_DEFAULT = 86400 // 24h -- one restart/day keeps it fresh

// Additive, idempotent, never-break-boot. No FK -> no CHECK-widen rebuild hazard.
export function migrateAckRegistry(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_ack_registry (
      agent_id    TEXT    PRIMARY KEY,
      declared_at INTEGER NOT NULL,
      ttl_seconds INTEGER NOT NULL DEFAULT 86400
    )
  `)
}

// Clamp a caller-supplied ttl into [MIN, MAX]. A missing / non-finite value
// falls back to the 24h default; a finite value out of range is floored/capped
// (so ttl_seconds:0 -> 3600, ttl_seconds:9999999 -> 604800). AV2-AC5.
export function clampTtl(ttl: unknown): number {
  if (typeof ttl !== 'number' || !Number.isFinite(ttl)) return ACK_TTL_DEFAULT
  const n = Math.floor(ttl)
  if (n < ACK_TTL_MIN) return ACK_TTL_MIN
  if (n > ACK_TTL_MAX) return ACK_TTL_MAX
  return n
}

export interface AckDeclaration {
  agent_id: string
  declared_at: number
  expires_at: number
}

// Upsert a declaration. `declared_at` is the server-stamped `now` (caller passes
// the server clock; a caller-supplied declared_at is never trusted -- spoof
// guard). INSERT OR REPLACE keeps exactly one row per agent (idempotent: a
// re-declare refreshes declared_at + ttl, no duplicate). AV2-AC4 / AV2-AC10.
export function declareAck(
  db: Database.Database,
  agentId: string,
  ttlSeconds: unknown,
  now: number,
): AckDeclaration {
  const ttl = clampTtl(ttlSeconds)
  db.prepare(
    'INSERT OR REPLACE INTO agent_ack_registry (agent_id, declared_at, ttl_seconds) VALUES (?, ?, ?)',
  ).run(agentId, now, ttl)
  return { agent_id: agentId, declared_at: now, expires_at: now + ttl }
}

// The authoritative capability read. Fail-closed on EVERY non-affirmative path:
// no row, expired row, OR any DB error (locked / corrupt / table missing). MUST
// NOT throw -- a thrown exception here would bubble into the message router and
// crash delivery for ALL in-flight messages. AV2-AC2 / AV2-AC3 + the
// DB-exception guard NoA called out as load-bearing.
export function isAckCapableInRegistry(db: Database.Database, agentId: string, now: number): boolean {
  try {
    const row = db
      .prepare('SELECT declared_at, ttl_seconds FROM agent_ack_registry WHERE agent_id = ?')
      .get(agentId) as { declared_at: number; ttl_seconds: number } | undefined
    if (!row) return false // no entry = fail-closed
    return row.declared_at + row.ttl_seconds > now // expired = fail-closed
  } catch {
    return false // DB error = fail-closed (never throw)
  }
}
