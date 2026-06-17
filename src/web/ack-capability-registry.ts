// ACK-capability V2 -- boot-time capability handshake backed by a TTL registry
// (card 83b7ec10).
//
// V1 (agent-config.ts: resolveAckCapableFromConfig / readAgentAckCapable) is a
// STATIC, fail-closed config flag: a recipient is ACK-capable only when its
// agent-config.json explicitly opts in (`ackCapable: true`). Correct, but the
// flag is manual -- nothing retracts it when the agent dies.
//
// V2 ADDS a self-declared, self-healing layer ON TOP of V1, never replacing it:
//   - On boot, the launcher records a declaration (agent_id, ackCapable=true, a
//     declared_at, and a ttl_expires_at = declared_at + TTL) in the durable
//     ack_capability_registry table.
//   - A live (now <= ttl_expires_at) declaration means the agent is currently up
//     and ACK-capable; when the agent dies it stops re-declaring, the TTL lapses,
//     and the declaration auto-expires -> the agent becomes not-capable WITHOUT
//     anyone editing the static flag (self-healing).
//
// The EFFECTIVE capability the router gates on is computed:
//   effective = (a LIVE, non-expired declaration is ackCapable) OR (static V1 flag)
//
// FAIL-CLOSED is mandatory and load-bearing: if the registry has no row for the
// agent, OR the row is expired, AND there is no static flag, the agent is NOT
// capable. A missing or expired registry must NEVER imply capable -- the worst
// case is the ACK protocol stays inert and the 1h-abandonment net backstops the
// message, which is exactly V1's fail-closed posture.
//
// All SQL is confined to the read/declare helpers (DB injectable for tests); the
// resolution decision (effectiveAckCapable) is a pure, unit-tested function.

import type Database from 'better-sqlite3'
import { getDb } from '../db.js'
import { logger } from '../logger.js'
import { readAgentAckCapable } from './agent-config.js'

// How long a boot declaration stays live. Sized to comfortably outlast the
// agent's re-declaration cadence (a fresh declaration is written on every
// launch/restart) so a still-running agent never spuriously lapses, while a dead
// agent's declaration expires within a bounded window and it self-heals to
// not-capable. 24h is a conservative default: long enough that a healthy agent
// that simply has not restarted in a day is not wrongly demoted (its static V1
// flag also still backstops it), short enough that a permanently-dead agent does
// not linger as "capable" indefinitely.
export const ACK_DECLARATION_TTL_MS = 24 * 60 * 60 * 1000

/** A single durable capability declaration row. */
export interface AckDeclaration {
  agentId: string
  ackCapable: boolean
  declaredAt: number
  ttlExpiresAt: number
}

// Pure: is this declaration LIVE (present and not yet expired) at `now`? A null
// declaration (no row) is never live. The boundary is inclusive (now ==
// ttl_expires_at still counts as live) so a declaration does not blink out one
// millisecond early.
export function isDeclarationLive(
  declaration: AckDeclaration | null,
  now: number,
): boolean {
  if (!declaration) return false
  return now <= declaration.ttlExpiresAt
}

// Pure, fail-closed resolver for the EFFECTIVE ACK-capability (card 83b7ec10).
// effective = (a LIVE declaration that is itself ackCapable) OR (the static V1 flag).
//
// Truth table (now vs ttl handled by isDeclarationLive):
//   live declaration, ackCapable=true   -> true   (self-declared, up)
//   live declaration, ackCapable=false  -> staticFlag   (declared NOT capable; V1 may still opt in)
//   expired declaration                 -> staticFlag   (lapsed -> fall back to V1)
//   no declaration                      -> staticFlag   (registry empty -> fall back to V1)
//
// FAIL-CLOSED: with no live capable declaration AND no static flag, the result is
// false. A missing/expired registry NEVER implies capable -- it only ever defers
// to the (already fail-closed) static flag.
export function effectiveAckCapable(
  declaration: AckDeclaration | null,
  staticFlag: boolean,
  now: number,
): boolean {
  if (isDeclarationLive(declaration, now) && declaration!.ackCapable) return true
  return staticFlag === true
}

// The EFFECTIVE ACK-capability the router gates on (card 83b7ec10): the V2
// composition of a LIVE durable declaration OR the static V1 flag. This is the
// single call the router substitutes for the bare V1 read. Both inputs are read
// FRESH on every call (no module cache) so a live config edit OR a fresh boot
// declaration takes effect at router time, not at dashboard boot. Fail-closed:
// if the registry read throws, fall back to the (already fail-closed) static V1
// flag alone -- a registry fault must never imply capable. DB injectable for
// tests; defaults to the live DB and Date.now().
export function readEffectiveAckCapable(
  agentId: string,
  now: number = Date.now(),
  db: Database.Database = getDb(),
): boolean {
  const staticFlag = readAgentAckCapable(agentId)
  let declaration: AckDeclaration | null = null
  try {
    declaration = readAckDeclaration(agentId, db)
  } catch (err) {
    // A registry read fault must never UPGRADE capability -- defer to V1 alone.
    logger.warn({ err, agentId }, 'ack-capability: registry read failed, falling back to static V1 flag')
    return staticFlag
  }
  return effectiveAckCapable(declaration, staticFlag, now)
}

// Map a raw DB row to a typed declaration. SQLite stores the boolean as 0/1.
function rowToDeclaration(row: {
  agent_id: string
  ack_capable: number
  declared_at: number
  ttl_expires_at: number
}): AckDeclaration {
  return {
    agentId: row.agent_id,
    ackCapable: row.ack_capable === 1,
    declaredAt: row.declared_at,
    ttlExpiresAt: row.ttl_expires_at,
  }
}

// Read the durable declaration for an agent, or null when no row exists. Does NOT
// filter on expiry -- the caller decides liveness via effectiveAckCapable so an
// expired row can still be observed (e.g. for diagnostics). DB injectable for
// tests; defaults to the live DB.
export function readAckDeclaration(
  agentId: string,
  db: Database.Database = getDb(),
): AckDeclaration | null {
  const row = db
    .prepare(
      'SELECT agent_id, ack_capable, declared_at, ttl_expires_at FROM ack_capability_registry WHERE agent_id = ?',
    )
    .get(agentId) as
    | { agent_id: string; ack_capable: number; declared_at: number; ttl_expires_at: number }
    | undefined
  return row ? rowToDeclaration(row) : null
}

// Record (UPSERT) a boot declaration for an agent. agent_id is the PK so a
// re-declaration on the next launch overwrites the previous row -- no row leak,
// the TTL window simply slides forward. ttl_expires_at = declaredAt + ttlMs.
// DB injectable for tests; defaults to the live DB. ttlMs defaults to the 24h
// boot TTL.
export function declareAckCapability(
  agentId: string,
  ackCapable: boolean,
  declaredAt: number,
  ttlMs: number = ACK_DECLARATION_TTL_MS,
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `INSERT INTO ack_capability_registry (agent_id, ack_capable, declared_at, ttl_expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       ack_capable = excluded.ack_capable,
       declared_at = excluded.declared_at,
       ttl_expires_at = excluded.ttl_expires_at`,
  ).run(agentId, ackCapable ? 1 : 0, declaredAt, declaredAt + ttlMs)
}

// Boot-declare side-effect for the launcher: on a successful agent launch, record
// a live ackCapable declaration so the registry reflects that this agent is up
// and able to confirm receipt. Best-effort and fully swallowed -- a registry
// write must NEVER block or fail an agent launch; if it throws, the static V1
// flag still governs capability (fail-closed). The decision of WHETHER an agent
// is ack-capable in principle remains V1's job (the static flag is the source of
// truth for that); V2 only records "this capable agent is currently alive". So we
// only ever DECLARE ackCapable=true here for an agent that V1 already deems
// capable -- the launcher passes that in. A non-capable agent simply never gets a
// live declaration and stays fail-closed via V1.
export function recordBootDeclaration(
  agentId: string,
  staticAckCapable: boolean,
  now: number = Date.now(),
): void {
  // Only declare for agents V1 already considers capable. Declaring a live
  // "true" for a non-capable agent would let V2 wrongly OVERRIDE the static
  // fail-closed default, which violates "V2 augments, V1 is the fail-closed
  // fallback". For a non-capable agent we write nothing (no row -> fail-closed).
  if (!staticAckCapable) return
  try {
    declareAckCapability(agentId, true, now)
  } catch (err) {
    logger.warn({ err, agentId }, 'ack-capability: boot declaration write failed (V1 static flag still governs)')
  }
}
