/**
 * Bridge test: run the shared-resolver + manual-reader live-DB resolution Python
 * suites under `npm test` (card 57480c07, claudeclaw.db retire PR3b).
 *
 * scripts/vault-lint-layer2.py and scripts/generate-concept-index.py are the
 * on-demand vault readers that still defaulted to the FROZEN store/claudeclaw.db.
 * Both now resolve the LIVE store/noa.db via the shared scripts/db_resolve.py
 * util (honors NOA_DB_PATH, fails open to noa.db). Wrapping the Python unittests
 * here means a regression in either fails the merge gate.
 *
 * status.ts (the third manual reader) is a top-level CLI that executes on import
 * (shells out to sqlite3/launchctl), so it is not unit-importable; its DB-path
 * logic is the already-tested resolveNoaDbPath (src/__tests__/db-path.test.ts),
 * wired in directly, and covered by tsc.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INSTALL_DIR = join(__dirname, '../..')

function runPy(relPath: string): void {
  try {
    execFileSync('python3', [join(INSTALL_DIR, relPath)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() ?? String(err)
    throw new Error(`Python suite failed (${relPath}):\n${stderr}`)
  }
}

describe('claudeclaw.db retire (PR3b): shared resolver + manual-reader live-DB resolution', () => {
  it('shared db_resolve util suite passes (exit 0)', () => {
    expect(() => runPy('scripts/test_db_resolve.py')).not.toThrow()
  })

  it('vault-lint + concept-index wiring suite passes (exit 0)', () => {
    expect(() => runPy('scripts/test_manual_readers_dbpath.py')).not.toThrow()
  })
})
