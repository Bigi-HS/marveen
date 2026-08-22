/**
 * Bridge test: run the SessionStart / UserPromptSubmit enforcement bundle's Python
 * suite under `npm test` (cards 03a4f57d + 705381e3).
 *
 * The enforcement logic lives in scripts/hooks/session_enforce_lib.py plus the two
 * hook entries (session-start-enforce.py, prompt-freshness-nudge.py). Its own tests
 * are Python unittest; wrapping them here means a regression in the per-agent
 * SessionStart reminders or in the long-session anti-bloat nudge (threshold gate /
 * cooldown / state tracking) fails the merge gate, which runs `npm test`.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INSTALL_DIR = join(__dirname, '../..')
const PY_TEST = join(INSTALL_DIR, 'scripts/hooks/test_session_enforce.py')

describe('session-enforce hooks (SessionStart checks + freshness nudge)', () => {
  it('the Python unittest suite passes (exit 0)', () => {
    let stderr = ''
    try {
      execFileSync('python3', [PY_TEST], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err: any) {
      stderr = err?.stderr?.toString?.() ?? String(err)
      throw new Error(`Python session-enforce test suite failed:\n${stderr}`)
    }
    // stderr is only assigned on a non-zero exit (the catch above); a clean pass
    // leaves it '' -- the assertion just confirms no test failed.
    expect(stderr).toBe('')
  })
})
