// Child-process entry for a full codetree rebuild (spawned by
// codetree-rebuild-spawn.ts). Runs the CPU-heavy TS-compiler parse off the
// dashboard HTTP event loop and prints the RebuildSummary as JSON on stdout.
import { initCodetreeDatabase } from './codetree-db.js'
import { rebuildIndex } from './codetree-rebuild.js'

try {
  initCodetreeDatabase()
  const summary = rebuildIndex()
  process.stdout.write(JSON.stringify(summary))
  process.exit(0)
} catch (err) {
  process.stderr.write(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
}
