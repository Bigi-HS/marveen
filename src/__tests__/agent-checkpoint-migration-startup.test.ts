// Guard: the agent_checkpoints migration must run in the REAL server startup
// path, not just in fixtures. A fixture-created table that prod never migrates
// is a false-green (database-designer lesson). This test asserts BOTH:
//   (1) web.ts's boot sequence calls applyCheckpointMigrations() (source-level),
//   (2) applyCheckpointMigrations against the live default noa.db creates the
//       table (live-DB assertion, not an in-memory fixture).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { applyCheckpointMigrations } from '../web/agent-checkpoint.js'
import { getNoaDb } from '../noa-db.js'

describe('agent_checkpoints migration is wired into the real startup', () => {
  it('web.ts boot calls applyCheckpointMigrations()', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'web.ts'), 'utf-8')
    expect(src).toContain('applyCheckpointMigrations()')
    // it must be imported from the module (not a stray string)
    expect(src).toMatch(/import\s*{\s*applyCheckpointMigrations\s*}\s*from\s*'\.\/web\/agent-checkpoint\.js'/)
  })

  it('applying against the live default noa.db creates the table (live-DB assertion)', () => {
    const db = getNoaDb() // the SAME DB the server opens at boot
    applyCheckpointMigrations(db)
    const t = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_checkpoints'",
    ).get()
    expect(t).toBeTruthy()
    // and the mirror index
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_checkpoints_agent'",
    ).get()
    expect(idx).toBeTruthy()
  })
})
