/**
 * Bridge test: run the Medic-bot + dream-engine live-DB resolution Python suites
 * under `npm test` (card 57480c07, claudeclaw.db retire PR3).
 *
 * Both modules still defaulted to the FROZEN store/claudeclaw.db:
 *   - scripts/medic/bot.py DB_PATH -> probe_stuck read a stale/empty
 *     agent_messages table (split-brain stuck-diagnosis).
 *   - scripts/memory/dream_engine.py VAULT_PATH -> consolidation scanned a stale
 *     vault and copy2-snapshotted the dead DB (latent capability-loss).
 * Both now resolve NOA_DB_PATH the same way the rest of the fleet does and fail
 * open to the LIVE store/noa.db. Wrapping the Python unittests here means a
 * regression in either fails the merge gate.
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

describe('claudeclaw.db retire (PR3): medic-bot + dream-engine live-DB resolution', () => {
  it('medic bot DB_PATH resolution suite passes (exit 0)', () => {
    expect(() => runPy('scripts/test_medic_bot_dbpath.py')).not.toThrow()
  })

  it('dream-engine vault-path resolution + core suite passes (exit 0)', () => {
    expect(() => runPy('scripts/memory/test_dream_engine.py')).not.toThrow()
  })
})
