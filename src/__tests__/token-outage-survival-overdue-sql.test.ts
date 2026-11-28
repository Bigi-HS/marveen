// Regression for noa.db drift: scheduled_tasks has no `name` column.
// The correct query must use `id AS name`; the old `SELECT id, name, ...` crashed.
// card aaf60b5e

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'

function createFixtureDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE scheduled_tasks (
      id          TEXT PRIMARY KEY,
      description TEXT,
      agent       TEXT,
      status      TEXT,
      next_run    INTEGER
    )
  `)
  return db
}

const FIXED_SQL = `
  SELECT id, id AS name, COALESCE(description,'') AS description, COALESCE(agent,'') AS agent
  FROM scheduled_tasks
  WHERE status='active' AND next_run <= ?
  ORDER BY next_run ASC LIMIT 10
`

const BUGGY_SQL = `
  SELECT id, name, COALESCE(description,'') AS description, COALESCE(agent,'') AS agent
  FROM scheduled_tasks
  WHERE status='active' AND next_run <= ?
  ORDER BY next_run ASC LIMIT 10
`

describe('defaultGetOverdueTasks SQL regression (aaf60b5e)', () => {
  it('fixed query returns rows with name === id when name column is absent', () => {
    const db = createFixtureDb()
    db.prepare(`INSERT INTO scheduled_tasks VALUES ('my-task','Daily backup','dave','active',0)`).run()

    const rows = db.prepare(FIXED_SQL).all(9_999_999_999) as Array<{
      id: string; name: string; description: string; agent: string
    }>

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('my-task')
    expect(rows[0].name).toBe('my-task')
    expect(rows[0].description).toBe('Daily backup')
    expect(rows[0].agent).toBe('dave')
  })

  it('fixed query returns empty array when no active overdue rows exist', () => {
    const db = createFixtureDb()
    db.prepare(`INSERT INTO scheduled_tasks VALUES ('future-task','x','dave','active',9999999999)`).run()

    const rows = db.prepare(FIXED_SQL).all(0)
    expect(rows).toHaveLength(0)
  })

  it('original buggy SELECT id, name, ... throws "no such column: name"', () => {
    const db = createFixtureDb()
    expect(() =>
      db.prepare(BUGGY_SQL).all(0)
    ).toThrow(/no such column/)
  })
})
