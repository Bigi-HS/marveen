/**
 * Bridge test: run the ledger live-DB resolution + conversation_log migration
 * Python suites under `npm test` (card 40002ca4).
 *
 * ledger_lib.db_path() now resolves NOA_DB_PATH (env / .env) the same way the
 * server does, so the ledger + memory-replay + hot-cache hooks read the live
 * noa.db instead of the frozen legacy claudeclaw.db. migrate-ledger-to-noa.py
 * backfills the post-cutover conversation_log rows before the flip. Wrapping the
 * Python unittests here means a regression in either fails the merge gate.
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

describe('ledger live-DB resolution + conversation_log migration', () => {
  it('db_path NOA_DB_PATH resolution suite passes (exit 0)', () => {
    expect(() => runPy('scripts/hooks/test_ledger_dbpath.py')).not.toThrow()
  })

  it('conversation_log migration suite passes (exit 0)', () => {
    expect(() => runPy('scripts/hooks/test_migrate_ledger.py')).not.toThrow()
  })

  it('inbound reconcile self-heal suite passes (exit 0)', () => {
    expect(() => runPy('scripts/hooks/test_ledger_reconcile.py')).not.toThrow()
  })
})
