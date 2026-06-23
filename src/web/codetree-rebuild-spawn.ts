import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import type { RebuildSummary } from './codetree-rebuild.js'

function isRebuildSummary(v: unknown): v is RebuildSummary {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.files_indexed === 'number' &&
    typeof o.symbols_indexed === 'number' &&
    typeof o.imports_indexed === 'number'
  )
}

// The worker shares stdout between its data channel (the summary JSON) and pino,
// which also logs to stdout: rebuildIndex() emits "codetree index rebuilt", and
// the pino-pretty transport flushes from a worker thread, so that line can land
// AFTER the JSON. A JSON.parse over the whole blob then throws and the daily
// rebuild 500s (card ee546ed2). Recover the summary by scanning lines for the
// one JSON object that has the summary shape -- robust to log noise on either
// side and to pino's production JSON mode (whose log line is valid JSON but is
// not a RebuildSummary, so the shape check rejects it).
export function extractRebuildSummary(stdout: string): RebuildSummary {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.length === 0 || line[0] !== '{') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (isRebuildSummary(parsed)) return parsed
  }
  throw new Error(`codetree rebuild worker produced no parseable summary: ${stdout.slice(0, 500)}`)
}

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
        resolve(extractRebuildSummary(stdout))
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  })
}
