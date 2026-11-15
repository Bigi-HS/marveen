// Hibiki daily-push trigger endpoint (card 13373343).
//
// POST /api/run/hibiki-daily-push
// Zero-LLM, single-purpose: spawns scripts/hibiki-daily-push.py once per
// invocation so an n8n Schedule Trigger can drive Hibiki's deterministic
// daily push WITHOUT a live Claude session. The dashboard-endpoint is the
// only legal path (n8n Execute Command node is disabled for safety).
//
// Auth is NOT handled here: the central route-chain gate in web.ts 401s any
// non-public /api write before dispatch (same posture as rgb.ts / ack.ts).
// The path MUST remain NON-public in public-paths.ts so the central gate
// enforces the bearer-token check.
//
// Security boundary: the script path is a hardcoded constant, never derived
// from the request. ZERO caller-controlled arguments are passed to execFile.
// No request body is read or interpreted.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../../config.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const HIBIKI_PUSH_SCRIPT = join(PROJECT_ROOT, 'scripts', 'hibiki-daily-push.py')
// Generous timeout: the script does a Telegram HTTP send which may be slow.
const EXEC_TIMEOUT_MS = 30000

// Injectable exec runner so route tests assert the exact argv passed to the
// spawn (mirrors rgb.ts __setRgbExecFile). Production uses the real
// promisified execFile.
type ExecFileFn = (file: string, args: string[], opts: { timeout: number }) => Promise<unknown>
const realExecFile = promisify(execFile) as unknown as ExecFileFn
let execFileAsync: ExecFileFn = realExecFile

export function __setRunExecFile(fn: ExecFileFn): void {
  execFileAsync = fn
}
export function __resetRunExecFile(): void {
  execFileAsync = realExecFile
}

export async function tryHandleRun(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path !== '/api/run/hibiki-daily-push') return false
  if (method !== 'POST') return false // only POST is defined; let other methods 404

  // Hardcoded argv -- ZERO caller-controlled arguments (no injection surface).
  try {
    await execFileAsync('python3', [HIBIKI_PUSH_SCRIPT], { timeout: EXEC_TIMEOUT_MS })
    json(res, { ok: true })
  } catch (err) {
    // Only exec/spawn failure maps to 500; stdout is never read (rgb.ts posture).
    const message = err instanceof Error ? err.message : String(err)
    json(res, { ok: false, error: message }, 500)
  }
  return true
}
