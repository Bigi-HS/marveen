// Live-DB resolution for the model-free child scripts (direct-send.py /
// fallback_llm_client.py) spawned by the schedule-runner (card b793b2d8).
//
// The token-outage bypass hardcoded `--db-path store/claudeclaw.db`, so a
// scheduled directSend/fallback that fires during an outage wrote its
// direct_send_log / layer2_call_log rows AND its kanban card updates/inserts
// into the FROZEN legacy DB -- invisible to the live board (noa.db). This was a
// latent split-brain bug (the log tables never appeared in either DB, proving
// the path had never run). scheduledDbPath resolves the LIVE DB from NOA_DB_PATH
// via the canonical resolveNoaDbPath (same guard as the app's own DB handle),
// falling back to claudeclaw.db only when NOA_DB_PATH is unset.

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { scheduledDbPath } from '../web/schedule-runner.js'

describe('scheduledDbPath (b793b2d8 pre-retire hardcode migration)', () => {
  it('resolves NOA_DB_PATH (the cutover live DB) against the project root', () => {
    expect(scheduledDbPath({ NOA_DB_PATH: 'store/noa.db' })).toBe(
      resolve(PROJECT_ROOT, 'store/noa.db'),
    )
  })

  it('falls back to claudeclaw.db when NOA_DB_PATH is unset', () => {
    expect(scheduledDbPath({})).toBe(resolve(PROJECT_ROOT, 'store/claudeclaw.db'))
  })

  it('falls back to claudeclaw.db when NOA_DB_PATH is blank', () => {
    expect(scheduledDbPath({ NOA_DB_PATH: '   ' })).toBe(
      resolve(PROJECT_ROOT, 'store/claudeclaw.db'),
    )
  })

  it('never returns the frozen legacy DB when the cutover is active', () => {
    const p = scheduledDbPath({ NOA_DB_PATH: 'store/noa.db' })
    expect(p.endsWith('claudeclaw.db')).toBe(false)
    expect(p.endsWith('noa.db')).toBe(true)
  })

  it('propagates the resolver guard: a non-.db target is rejected', () => {
    expect(() => scheduledDbPath({ NOA_DB_PATH: 'store/evil.txt' })).toThrow(/\.db file/)
  })

  it('propagates the resolver guard: a path escaping the project root is rejected', () => {
    expect(() => scheduledDbPath({ NOA_DB_PATH: '../outside.db' })).toThrow(/escapes the project root/)
  })
})
