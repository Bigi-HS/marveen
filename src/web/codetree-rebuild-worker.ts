// Child-process entry for a full codetree rebuild (spawned by
// codetree-rebuild-spawn.ts). Runs the CPU-heavy TS-compiler parse off the
// dashboard HTTP event loop and prints the RebuildSummary as JSON on stdout.
import { initCodetreeDatabase } from './codetree-db.js'
import { rebuildIndex } from './codetree-rebuild.js'

try {
  initCodetreeDatabase()
  const summary = rebuildIndex()
  // Isolate the data channel from pino log noise on stdout: a leading newline
  // guarantees the summary starts a fresh line even if pino flushed a partial
  // line first, and the trailing newline pushes any later pino flush onto its
  // own line. Wait for the write to drain before exit() -- otherwise a premature
  // process.exit can truncate the pipe and the parent sees no summary (2026-06-25).
  process.stdout.write('\n' + JSON.stringify(summary) + '\n', () => process.exit(0))
} catch (err) {
  process.stderr.write(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
}
