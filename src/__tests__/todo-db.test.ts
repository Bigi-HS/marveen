import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { rmSync } from 'node:fs'
import {
  initDatabase, getDb, nowEpochS, dayBucket,
  createTodoItem, getTodoItem, listActiveTodos, updateTodoItem,
  markTodoDone, tickTodoProgress, deleteTodoItem,
  todoLastWriteAgoSeconds, recentDayBuckets, trainingAdherence,
} from '../db.js'

const TEST_DB = '/tmp/test-todo-db.db'

function setCreatedAt(id: string, epoch: number): void {
  getDb().prepare('UPDATE todo_items SET created_at = ? WHERE id = ?').run(epoch, id)
}
function setDoneAt(id: string, epoch: number): void {
  getDb().prepare('UPDATE todo_items SET done = 1, done_at = ? WHERE id = ?').run(epoch, id)
}
function setUpdatedAt(id: string, epoch: number): void {
  getDb().prepare('UPDATE todo_items SET updated_at = ? WHERE id = ?').run(epoch, id)
}

describe('todo_items schema (DM-AC1 / DM-AC3)', () => {
  beforeEach(() => { rmSync(TEST_DB, { force: true }); initDatabase(TEST_DB) })
  afterAll(() => rmSync(TEST_DB, { force: true }))

  it('has all columns with expected names', () => {
    const cols = (getDb().prepare("PRAGMA table_info(todo_items)").all() as Array<{ name: string }>).map(c => c.name)
    for (const c of ['id', 'owner', 'section', 'kind', 'title', 'detail', 'done', 'status',
      'target_val', 'actual_val', 'sort_order', 'last_progress_at', 'progress_note',
      'created_at', 'updated_at', 'done_at']) {
      expect(cols).toContain(c)
    }
  })

  it('accepts kind=progress from the initial CREATE (no CHECK-widening)', () => {
    createTodoItem({ id: 'p1', owner: 'claudia', section: 'learning', kind: 'progress', title: 'ISTQB' })
    expect(getTodoItem('p1')?.kind).toBe('progress')
  })

  it('rejects an invalid owner via CHECK', () => {
    expect(() => getDb().prepare(
      "INSERT INTO todo_items (id, owner, title, created_at, updated_at) VALUES ('x','nobody','t',1,1)"
    ).run()).toThrow()
  })

  it('rejects an invalid kind via CHECK', () => {
    expect(() => getDb().prepare(
      "INSERT INTO todo_items (id, owner, kind, title, created_at, updated_at) VALUES ('x','claudia','bogus','t',1,1)"
    ).run()).toThrow()
  })

  it('accepts owner=bond on a fresh install (card 2f7cd951 third owner)', () => {
    createTodoItem({ id: 'b1', owner: 'bond', section: 'learning', kind: 'progress', title: 'ISTQB drill' })
    expect(getTodoItem('b1')?.owner).toBe('bond')
    expect(listActiveTodos('bond').map(r => r.id)).toContain('b1')
  })
})

describe('todo create/edit server-stamps timestamps (DM-AC2)', () => {
  beforeEach(() => { rmSync(TEST_DB, { force: true }); initDatabase(TEST_DB) })
  afterAll(() => rmSync(TEST_DB, { force: true }))

  it('stamps created_at/updated_at at the server clock, ignoring any provided', () => {
    const before = nowEpochS()
    createTodoItem({ id: 't1', owner: 'claudia', title: 'task' })
    const row = getTodoItem('t1')!
    expect(row.created_at).toBeGreaterThanOrEqual(before)
    expect(row.updated_at).toBeGreaterThanOrEqual(before)
    expect(row.done).toBe(0)
    expect(row.done_at).toBeNull()
    // default kind is 'task'
    expect(row.kind).toBe('task')
  })

  it('markTodoDone sets done=1 + done_at server-side', () => {
    createTodoItem({ id: 't2', owner: 'claudia', title: 'task' })
    const before = nowEpochS()
    expect(markTodoDone('t2')).toBe(true)
    const row = getTodoItem('t2')!
    expect(row.done).toBe(1)
    expect(row.done_at).toBeGreaterThanOrEqual(before)
  })

  it('tickTodoProgress sets last_progress_at + note, keeps done=0', () => {
    createTodoItem({ id: 't3', owner: 'claudia', section: 'learning', kind: 'progress', title: 'ISTQB' })
    expect(tickTodoProgress('t3', 'finished chapter 4')).toBe(true)
    const row = getTodoItem('t3')!
    expect(row.last_progress_at).not.toBeNull()
    expect(row.progress_note).toBe('finished chapter 4')
    expect(row.done).toBe(0)
  })
})

describe('listActiveTodos lazy-archives yesterday\'s completed (TC-AC3)', () => {
  beforeEach(() => { rmSync(TEST_DB, { force: true }); initDatabase(TEST_DB) })
  afterAll(() => rmSync(TEST_DB, { force: true }))

  it('hides items completed before today\'s bucket, keeps open + today-done', () => {
    const twoDaysAgo = nowEpochS() - 2 * 86400
    createTodoItem({ id: 'old-done', owner: 'claudia', title: 'done yesterday' })
    setDoneAt('old-done', twoDaysAgo)
    createTodoItem({ id: 'today-done', owner: 'claudia', title: 'done today' })
    markTodoDone('today-done')
    createTodoItem({ id: 'open', owner: 'claudia', title: 'still open' })

    const ids = listActiveTodos('claudia').map(r => r.id)
    expect(ids).toContain('open')
    expect(ids).toContain('today-done')
    expect(ids).not.toContain('old-done')
  })

  it('scopes by owner', () => {
    createTodoItem({ id: 'c', owner: 'claudia', title: 'c task' })
    createTodoItem({ id: 'h', owner: 'hibiki', section: 'fitness', kind: 'habit', title: 'training' })
    expect(listActiveTodos('claudia').map(r => r.id)).toEqual(['c'])
    expect(listActiveTodos('hibiki').map(r => r.id)).toEqual(['h'])
  })
})

describe('deleteTodoItem hard-deletes (CAR-AC4)', () => {
  beforeEach(() => { rmSync(TEST_DB, { force: true }); initDatabase(TEST_DB) })
  afterAll(() => rmSync(TEST_DB, { force: true }))

  it('removes the row permanently', () => {
    createTodoItem({ id: 'd1', owner: 'claudia', title: 'dismiss me' })
    expect(deleteTodoItem('d1')).toBe(true)
    expect(getTodoItem('d1')).toBeUndefined()
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM todo_items WHERE id=?').get('d1')).toEqual({ c: 0 })
  })

  it('returns false for an unknown id', () => {
    expect(deleteTodoItem('nope')).toBe(false)
  })
})

describe('freshness sentinel (FS-AC1)', () => {
  beforeEach(() => { rmSync(TEST_DB, { force: true }); initDatabase(TEST_DB) })
  afterAll(() => rmSync(TEST_DB, { force: true }))

  it('returns null when the owner has no rows', () => {
    expect(todoLastWriteAgoSeconds('hibiki')).toBeNull()
  })

  it('returns seconds since the most recent write', () => {
    createTodoItem({ id: 'f1', owner: 'claudia', title: 't' })
    setUpdatedAt('f1', nowEpochS() - 3600)
    const ago = todoLastWriteAgoSeconds('claudia')!
    expect(ago).toBeGreaterThanOrEqual(3590)
    expect(ago).toBeLessThanOrEqual(3700)
  })
})

describe('training adherence (FIT-AC5)', () => {
  beforeEach(() => { rmSync(TEST_DB, { force: true }); initDatabase(TEST_DB) })
  afterAll(() => rmSync(TEST_DB, { force: true }))

  it('recentDayBuckets returns 7 strictly-decreasing bucket boundaries', () => {
    const b = recentDayBuckets(7)
    expect(b).toHaveLength(7)
    for (let i = 1; i < b.length; i++) expect(b[i]).toBeLessThan(b[i - 1])
    expect(b[0]).toBe(dayBucket(nowEpochS()))
  })

  it('counts only buckets with a done training item; rest/skipped do not count', () => {
    const buckets = recentDayBuckets(7)
    // done in bucket 0 (today) and bucket 2; rest in bucket 1; skipped in bucket 3.
    const inBucket = (b: number) => b + 4 * 3600 // 07:00-ish, safely inside the bucket
    const mk = (id: string, b: number, status: string) => {
      createTodoItem({ id, owner: 'hibiki', section: 'fitness', kind: 'habit', title: 'training', status })
      setCreatedAt(id, inBucket(b))
    }
    mk('d0', buckets[0], 'done')
    mk('r1', buckets[1], 'rest')
    mk('d2', buckets[2], 'done')
    mk('s3', buckets[3], 'skipped')

    const { active, total } = trainingAdherence('hibiki', 7)
    expect(total).toBe(7)
    expect(active).toBe(2) // only the two 'done' buckets
  })

  it('counts a 01:30-Budapest training in the PREVIOUS bucket, not today', () => {
    const buckets = recentDayBuckets(7)
    // place a done training 30 min before today's 03:00 boundary -> previous bucket.
    createTodoItem({ id: 'late', owner: 'hibiki', section: 'fitness', kind: 'habit', title: 'training', status: 'done' })
    setCreatedAt('late', buckets[0] - 1800)
    const { active } = trainingAdherence('hibiki', 7)
    // it belongs to buckets[1]; today's bucket has no done item.
    expect(active).toBe(1)
    expect(dayBucket(buckets[0] - 1800)).toBe(buckets[1])
  })
})
