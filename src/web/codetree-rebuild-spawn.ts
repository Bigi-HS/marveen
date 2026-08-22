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

// Extract the balanced, string-aware JSON object that starts at `start` (a '{').
// Returns the slice end index (exclusive) or -1 if no balanced object is found.
// String-aware so a brace inside a JSON string value never miscounts depth.
function balancedObjectEnd(s: string, start: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

// The worker shares stdout between its data channel (the summary JSON) and pino,
// which also logs to stdout: rebuildIndex() emits "codetree index rebuilt", and
// the pino-pretty transport flushes from a worker thread, so that line can land
// AFTER the JSON -- and, because the summary was written WITHOUT a trailing
// newline, the pino tail can land on the SAME line right after the closing brace
// (`{...}[03:01:51] INFO codetree index rebuilt`). A JSON.parse over the whole
// line then throws and the daily rebuild 500s (cards ee546ed2 + 2026-06-25).
// Recover the summary by scanning EVERY '{' in the blob for the one balanced,
// string-aware JSON object that has the summary shape -- robust to log noise
// before, after, or fused onto the summary's line, and to pino's production JSON
// mode (whose log line is valid JSON but is not a RebuildSummary, so the shape
// check rejects it). Scan bottom-up / right-to-left so the summary wins over any
// earlier log object when both are present.
export function extractRebuildSummary(stdout: string): RebuildSummary {
  const starts: number[] = []
  for (let i = 0; i < stdout.length; i++) {
    if (stdout[i] === '{') starts.push(i)
  }
  for (let k = starts.length - 1; k >= 0; k--) {
    const start = starts[k]
    const end = balancedObjectEnd(stdout, start)
    if (end < 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout.slice(start, end))
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
