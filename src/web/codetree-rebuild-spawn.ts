import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import type { RebuildSummary } from './codetree-rebuild.js'

// Run the rebuild in a child process so the CPU-heavy TS-compiler parse never
// blocks the dashboard HTTP event loop (OQ2). The worker is the compiled
// sibling module; it prints the RebuildSummary as JSON on stdout.
export function spawnRebuildWorker(): Promise<RebuildSummary> {
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'codetree-rebuild-worker.js')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { cwd: PROJECT_ROOT })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`codetree rebuild worker exited ${code}: ${stderr.slice(0, 500)}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as RebuildSummary)
      } catch {
        reject(new Error(`codetree rebuild worker produced invalid output: ${stdout.slice(0, 200)}`))
      }
    })
  })
}
