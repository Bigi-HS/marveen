// P9 sandbox isolation guard (card p9-sandbox-foundation).
//
// When SANDBOX_ISOLATION=1, validates at startup that the resolved DB path is
// NOT the canonical live database. If it matches, throws immediately so the
// process aborts before opening any file handle on the live noa.db.
//
// Design rationale: the sandbox and live server use the same codebase/dist --
// the only thing separating them is NOA_DB_PATH + empty channel tokens. If
// NOA_DB_PATH is misconfigured (e.g. falls back to default because the env var
// was lost), this guard catches it before any writes land on the live fleet DB.
//
// Called from db.ts initDatabase() after resolving dbPath.

import { resolve, join } from 'node:path'
import { DB_FILENAME } from './config.js'

/**
 * Throws if SANDBOX_ISOLATION=1 and resolvedDbPath matches the canonical live DB.
 *
 * No-op when:
 *   - SANDBOX_ISOLATION is unset or not '1'
 *   - resolvedDbPath points to a non-live location
 */
export function assertSandboxIsolation(resolvedDbPath: string, projectRoot: string): void {
  if (process.env['SANDBOX_ISOLATION'] !== '1') return

  const liveDbPath = resolve(join(projectRoot, 'store', DB_FILENAME))
  if (resolve(resolvedDbPath) === liveDbPath) {
    throw new Error(
      `SANDBOX_ISOLATION=1 but NOA_DB_PATH resolves to the live database (${liveDbPath}). ` +
      `Set NOA_DB_PATH to a sandbox copy (e.g. store/sandbox/noa.db) or unset SANDBOX_ISOLATION.`,
    )
  }
}
