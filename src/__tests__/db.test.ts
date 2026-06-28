import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { statSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initDatabase,
  createAgentMessage,
  getPendingMessages,
  markMessageDelivered,
  markMessageDone,
  markMessageFailed,
  getMessageStatusesByIds,
  getDb,
  tightenDbPermissions,
  upsertPendingTaskRetry,
  insertPendingTaskRetryIfNew,
  updatePendingTaskRetry,
  listPendingTaskRetries,
  getPendingTaskRetry,
  deletePendingTaskRetry,
  deletePendingTaskRetryById,
  markPendingTaskRetryAlert,
  clearPendingTaskRetryAlert,
} from '../db.js'

// Use in-memory database for tests to avoid polluting the live vault.
// Each test run gets a fresh, isolated DB that doesn't affect store/claudeclaw.db.
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

describe('agent_messages ack_expected (card 1a99b7e2)', () => {
  it('defaults ack_expected to 0 for a plain message', () => {
    const msg = createAgentMessage('thor', 'dave', 'plain peer note')
    expect(msg.ack_expected).toBe(0)
    const pending = getPendingMessages('dave').find((m) => m.id === msg.id)
    expect(pending?.ack_expected).toBe(0)
  })

  it('persists ack_expected=1 when the sender opts in', () => {
    const msg = createAgentMessage('thor', 'dave', 'please ACK this delegation', true)
    expect(msg.ack_expected).toBe(1)
    const pending = getPendingMessages('dave').find((m) => m.id === msg.id)
    expect(pending?.ack_expected).toBe(1)
  })
})

describe('agent_messages priority (card 28d2179f)', () => {
  it('defaults priority to "normal" for a plain message', () => {
    const msg = createAgentMessage('thor', 'dave', 'no explicit priority')
    expect(msg.priority).toBe('normal')
    const pending = getPendingMessages('dave').find((m) => m.id === msg.id)
    expect(pending?.priority).toBe('normal')
  })

  it('persists an explicit urgent priority through the pending queue', () => {
    const msg = createAgentMessage('thor', 'dave', 'gate-req, time-sensitive', false, 'urgent')
    expect(msg.priority).toBe('urgent')
    const pending = getPendingMessages('dave').find((m) => m.id === msg.id)
    expect(pending?.priority).toBe('urgent')
  })

  it('priority is independent of ack_expected (both can be set)', () => {
    const msg = createAgentMessage('thor', 'dave', 'urgent delegation', true, 'high')
    expect(msg.ack_expected).toBe(1)
    expect(msg.priority).toBe('high')
  })
})

// Card d4fe794f: additive nullable in_reply_to column -- the sender-side parent
// id that lets the router auto-correlate "C's reply to A" (the substrate the
// ACK protocol, card 1a99b7e2, can later build explicit threading on). Additive
// + fail-open: a plain message stays unthreaded (NULL), so old rows / old
// senders never break.
describe('agent_messages in_reply_to (card d4fe794f)', () => {
  it('defaults in_reply_to to null for a plain (unthreaded) message', () => {
    const msg = createAgentMessage('thor', 'dave', 'unthreaded note')
    expect(msg.in_reply_to).toBeNull()
    const pending = getPendingMessages('dave').find((m) => m.id === msg.id)
    expect(pending?.in_reply_to).toBeNull()
  })

  it('persists the parent message id through the pending queue', () => {
    const parent = createAgentMessage('dave', 'thor', 'original ask')
    const reply = createAgentMessage('thor', 'dave', 'my answer', false, 'normal', parent.id)
    expect(reply.in_reply_to).toBe(parent.id)
    const pending = getPendingMessages('dave').find((m) => m.id === reply.id)
    expect(pending?.in_reply_to).toBe(parent.id)
  })

  it('in_reply_to is independent of priority and ack_expected (all three compose)', () => {
    const msg = createAgentMessage('thor', 'dave', 'threaded + urgent + ack', true, 'urgent', 7)
    expect(msg.ack_expected).toBe(1)
    expect(msg.priority).toBe('urgent')
    expect(msg.in_reply_to).toBe(7)
  })
})


describe('pending task retries', () => {
  // The persistent test DB is shared with the running dashboard (both
  // resolve STORE_DIR to the same absolute path), so a blanket DELETE
  // would wipe the operator's real pending retries. Scope the cleanup to
  // the exact fixture names used below, and run it both before and after
  // so a re-run cleans up after itself even if an assertion throws.
  const FIXTURE_NAMES = [
    'task-a', 'task-b', 'task-c', 'task-d', 'task-e', 'task-f',
    'task-old', 'task-new', 'task-new-only', 'task-upd-only',
    'task-clear-alert',
  ]
  const wipeFixtures = () => {
    const stmt = getDb().prepare('DELETE FROM pending_task_retries WHERE task_name = ?')
    for (const n of FIXTURE_NAMES) stmt.run(n)
  }
  beforeAll(wipeFixtures)
  afterAll(wipeFixtures)

  it('inserts a new row on first upsert', () => {
    upsertPendingTaskRetry('task-a', 'main', 1_000_000, 'busy')
    const row = getPendingTaskRetry('task-a', 'main')
    expect(row).toMatchObject({
      task_name: 'task-a',
      agent_name: 'main',
      first_attempt: 1_000_000,
      last_attempt: 1_000_000,
      attempt_count: 1,
      last_reason: 'busy',
      alert_sent_at: null,
    })
  })

  it('bumps attempt_count and last_attempt on subsequent upserts, preserves first_attempt', () => {
    upsertPendingTaskRetry('task-b', 'main', 2_000_000, 'busy')
    upsertPendingTaskRetry('task-b', 'main', 2_000_500, 'busy')
    upsertPendingTaskRetry('task-b', 'main', 2_001_000, 'busy')
    const row = getPendingTaskRetry('task-b', 'main')!
    expect(row.first_attempt).toBe(2_000_000)
    expect(row.last_attempt).toBe(2_001_000)
    expect(row.attempt_count).toBe(3)
  })

  it('lists entries ordered by first_attempt ASC', () => {
    upsertPendingTaskRetry('task-old', 'main', 3_000_000, 'busy')
    upsertPendingTaskRetry('task-new', 'main', 4_000_000, 'busy')
    const rows = listPendingTaskRetries().filter(r => ['task-old', 'task-new'].includes(r.task_name))
    expect(rows[0].task_name).toBe('task-old')
    expect(rows[1].task_name).toBe('task-new')
  })

  it('deletes by (name, agent) returning true; false when absent', () => {
    upsertPendingTaskRetry('task-c', 'main', 5_000_000, 'busy')
    expect(deletePendingTaskRetry('task-c', 'main')).toBe(true)
    expect(deletePendingTaskRetry('task-c', 'main')).toBe(false)
  })

  it('deletes by id returning true; false when absent', () => {
    upsertPendingTaskRetry('task-d', 'main', 6_000_000, 'busy')
    const row = getPendingTaskRetry('task-d', 'main')!
    expect(deletePendingTaskRetryById(row.id)).toBe(true)
    expect(deletePendingTaskRetryById(row.id)).toBe(false)
  })

  it('markAlert sets alert_sent_at only once (subsequent calls no-op)', () => {
    upsertPendingTaskRetry('task-e', 'main', 7_000_000, 'busy')
    expect(markPendingTaskRetryAlert('task-e', 'main', 7_000_100)).toBe(true)
    expect(markPendingTaskRetryAlert('task-e', 'main', 7_000_200)).toBe(false)
    const row = getPendingTaskRetry('task-e', 'main')!
    expect(row.alert_sent_at).toBe(7_000_100)
  })

  it('separate (name, agent) pairs are distinct rows', () => {
    upsertPendingTaskRetry('task-f', 'agent-1', 8_000_000, 'busy')
    upsertPendingTaskRetry('task-f', 'agent-2', 8_000_000, 'busy')
    const rows = listPendingTaskRetries().filter(r => r.task_name === 'task-f')
    expect(rows).toHaveLength(2)
  })

  it('insertPendingTaskRetryIfNew inserts once then refuses', () => {
    expect(insertPendingTaskRetryIfNew('task-new-only', 'main', 9_000_000, 'busy')).toBe(true)
    expect(insertPendingTaskRetryIfNew('task-new-only', 'main', 9_000_100, 'busy')).toBe(false)
    const row = getPendingTaskRetry('task-new-only', 'main')!
    // first_attempt stays at the original (9_000_000), not the second call
    expect(row.first_attempt).toBe(9_000_000)
    expect(row.attempt_count).toBe(1)
  })

  it('updatePendingTaskRetry only mutates existing rows (no insert)', () => {
    // No row yet -> returns false, no row created
    expect(updatePendingTaskRetry('task-upd-only', 'main', 10_000_000, 'busy')).toBe(false)
    expect(getPendingTaskRetry('task-upd-only', 'main')).toBeUndefined()

    // After insert, update bumps attempt_count + last_attempt
    insertPendingTaskRetryIfNew('task-upd-only', 'main', 10_000_000, 'busy')
    expect(updatePendingTaskRetry('task-upd-only', 'main', 10_000_500, 'error')).toBe(true)
    const row = getPendingTaskRetry('task-upd-only', 'main')!
    expect(row.last_attempt).toBe(10_000_500)
    expect(row.attempt_count).toBe(2)
    expect(row.last_reason).toBe('error')
  })

  it('clearPendingTaskRetryAlert resets alert_sent_at so the next tick can retry', () => {
    insertPendingTaskRetryIfNew('task-clear-alert', 'main', 11_000_000, 'busy')
    markPendingTaskRetryAlert('task-clear-alert', 'main', 11_000_100)
    expect(getPendingTaskRetry('task-clear-alert', 'main')!.alert_sent_at).toBe(11_000_100)

    expect(clearPendingTaskRetryAlert('task-clear-alert', 'main')).toBe(true)
    expect(getPendingTaskRetry('task-clear-alert', 'main')!.alert_sent_at).toBeNull()

    // After clear, markAlert succeeds again
    expect(markPendingTaskRetryAlert('task-clear-alert', 'main', 11_000_200)).toBe(true)
  })
})

describe('database file permissions', () => {
  // Verifies tightenDbPermissions enforcement on a THROWAWAY temp directory,
  // never the live vault (store/claudeclaw.db). We create files at a loose
  // 0o644 and assert tightenDbPermissions narrows them to owner-only 0o600.
  // This proves the enforcement actually changes mode bits (a no-op impl
  // would fail) without any risk of touching or restoring the operator's DB.
  let tmpDir: string
  let dbPath: string
  const sidecarSuffixes = ['', '-wal', '-shm', '-journal'] as const

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'db-perms-'))
    dbPath = join(tmpDir, 'throwaway.db')
    // Create the main file + every sidecar at a deliberately loose 0o644 so
    // the narrowing is observable.
    for (const suffix of sidecarSuffixes) {
      const p = `${dbPath}${suffix}`
      writeFileSync(p, '')
      chmodSync(p, 0o644)
      // Confirm the precondition: files really start loose.
      expect(statSync(p).mode & 0o777).toBe(0o644)
    }
    tightenDbPermissions(dbPath)
  })

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('narrows the main DB file from 0o644 to owner-only 0o600', () => {
    expect(statSync(dbPath).mode & 0o777).toBe(0o600)
  })

  it('narrows the WAL sidecar to 0o600', () => {
    expect(statSync(`${dbPath}-wal`).mode & 0o777).toBe(0o600)
  })

  it('narrows the SHM sidecar to 0o600', () => {
    expect(statSync(`${dbPath}-shm`).mode & 0o777).toBe(0o600)
  })

  it('narrows the rollback-journal sidecar to 0o600', () => {
    expect(statSync(`${dbPath}-journal`).mode & 0o777).toBe(0o600)
  })

  it('tolerates a missing sidecar without throwing', () => {
    const absent = join(tmpDir, 'does-not-exist.db')
    expect(() => tightenDbPermissions(absent)).not.toThrow()
  })
})

// Card 681f99b0 (A2): the boot-fold reconciles outstanding pending-acks against
// the message lifecycle, so it needs the statuses of a set of message ids.
describe('getMessageStatusesByIds (A2 boot-fold reconcile)', () => {
  it('returns each id mapped to its current status, omitting unknown ids', () => {
    const pending = createAgentMessage('thor', 'dave', 'still pending')
    const delivered = createAgentMessage('thor', 'dave', 'delivered one')
    const done = createAgentMessage('thor', 'dave', 'done one')
    const failed = createAgentMessage('thor', 'dave', 'failed one')
    markMessageDelivered(delivered.id)
    markMessageDone(done.id, 'ok')
    markMessageFailed(failed.id, 'boom')

    const statuses = getMessageStatusesByIds([pending.id, delivered.id, done.id, failed.id, 999999])
    expect(statuses.get(pending.id)).toBe('pending')
    expect(statuses.get(delivered.id)).toBe('delivered')
    expect(statuses.get(done.id)).toBe('done')
    expect(statuses.get(failed.id)).toBe('failed')
    expect(statuses.has(999999)).toBe(false)
  })

  it('returns an empty map for no ids', () => {
    expect(getMessageStatusesByIds([]).size).toBe(0)
  })
})
