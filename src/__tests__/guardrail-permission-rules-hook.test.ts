/**
 * Bridge test: run the authoritative permission-ruleset guard hook's Python test
 * suite under `npm test` (card ec7754d7).
 *
 * The runtime enforcement of the external-curl / env-file rules lives in
 * scripts/hooks/guardrail-permission-rules.py (the PreToolUse hook). Its own tests
 * are Python unittest (scripts/hooks/test_guardrail-permission-rules.py) and were
 * NOT part of the vitest suite, so a regression in the hook -- e.g. re-opening the
 * direct GitHub merge-endpoint bypass this card closes -- would not be caught by
 * the merge gate (which runs `npm test`). This wraps the Python suite so a break
 * fails the gate. The src/web/permission-rules.ts engine has its own TS coverage
 * (permission-rules.test.ts); this covers the DIFFERENT, authoritative hook.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INSTALL_DIR = join(__dirname, '../..')
const PY_TEST = join(INSTALL_DIR, 'scripts/hooks/test_guardrail_permission_rules.py')

describe('guardrail-permission-rules.py hook (authoritative curl/env guard)', () => {
  it('the Python unittest suite passes (exit 0)', () => {
    // Throws (non-zero exit) if any Python guard test fails; the message carries
    // the unittest output so a gate failure is self-explaining.
    let stderr = ''
    try {
      execFileSync('python3', [PY_TEST], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err: any) {
      stderr = err?.stderr?.toString?.() ?? String(err)
      throw new Error(`Python guard test suite failed:\n${stderr}`)
    }
    expect(stderr).toBe('')
  })
})
