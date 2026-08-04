// Guard event recorder: HMAC key management + structured row insertion.
// Separate from dashboard-auth so the guard key can be rotated independently
// (rotating the session secret must not invalidate historical content hashes).
//
// SEC-030 / card 90c8c74b

import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { insertGuardEvent, type InsertGuardEventInput } from '../db.js'
import { logger } from '../logger.js'

const GUARD_KEY_PATH = join(STORE_DIR, '.guard-hmac-key')

let guardKey: Buffer | undefined

function loadOrCreateGuardKey(): Buffer {
  if (guardKey) return guardKey
  // Track why we are rotating so the warn is specific and always fires when a
  // pre-existing key is discarded.  A missing file (first start) is silent --
  // that is not a rotation.
  let reason: string | null = null
  try {
    if (existsSync(GUARD_KEY_PATH)) {
      const hex = readFileSync(GUARD_KEY_PATH, 'utf-8').trim()
      // Buffer.from(hex, 'hex') silently produces a zero-length Buffer for
      // non-hex characters, turning the key into a public constant.
      // Validate the hex string and the resulting key length explicitly.
      if (/^[0-9a-fA-F]{64}$/.test(hex)) {
        const buf = Buffer.from(hex, 'hex')
        if (buf.length === 32) {
          guardKey = buf
          return guardKey
        }
        reason = 'key file decoded to an unexpected length'
      } else {
        reason = 'key file is not 64 hex characters'
      }
    }
  } catch (err) {
    reason = `key file unreadable: ${(err as Error).message}`
  }
  if (reason) {
    logger.warn({ reason }, 'guard-event-recorder: rotating to a fresh key -- prior content_hash values are no longer comparable')
  }
  const fresh = randomBytes(32)
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  atomicWriteFileSync(GUARD_KEY_PATH, fresh.toString('hex'), { mode: 0o600 })
  guardKey = fresh
  return fresh
}

function hmacContent(content: string): string {
  return createHmac('sha256', loadOrCreateGuardKey()).update(content.trim()).digest('hex')
}

export interface GuardEventInput {
  mechanism: 'messages-guard' | 'memories-filter'
  route: '/api/messages' | '/api/memories'
  verdict: 'PASS' | 'FLAG' | 'BLOCK'
  fromAgent: string | null
  toAgent: string | null
  /** sorted, comma-joined matched pattern names; null on PASS */
  patternIds: string | null
  /** highest severity among matched patterns; null on PASS */
  maxSeverity: string | null
  findingCount: number
  content: string
}

export function recordGuardEvent(input: GuardEventInput, nowSec?: number): void {
  try {
    const ts = nowSec ?? Math.floor(Date.now() / 1000)
    const row: InsertGuardEventInput = {
      created_at: ts,
      mechanism: input.mechanism,
      route: input.route,
      verdict: input.verdict,
      from_agent: input.fromAgent,
      to_agent: input.toAgent,
      pattern_ids: input.patternIds,
      max_severity: input.maxSeverity,
      finding_count: input.findingCount,
      content_hash: hmacContent(input.content),
      content_len: input.content.length,
    }
    insertGuardEvent(row)
  } catch (err) {
    logger.warn({ err }, 'guard-event-recorder: failed to persist row (non-fatal)')
  }
}

// Exposed for tests: allows injecting a known key so HMAC stability can be
// verified without touching the on-disk key file.
export function _setGuardKeyForTest(key: Buffer): void {
  guardKey = key
}

// Exposed for tests: clears the cached key so the next call to loadOrCreateGuardKey
// reads from disk (needed to test the garbage-key-file path).
export function _resetGuardKeyForTest(): void {
  guardKey = undefined
}
