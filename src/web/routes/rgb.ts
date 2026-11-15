// RGB lights control endpoint (card 18bd8d31).
//
// POST /api/rgb/lights  { "action": "off" | "on", "color"?: "RRGGBB" }
// Server-side of the Boss-requested RGB dark-mode automation: an n8n schedule
// (23:30 off / 07:00 on) POSTs here with a Dashboard Bearer credential, because
// n8n's Execute Command node is disabled for safety -- the fleet pattern is an
// httpRequest into a dashboard endpoint (mirrors routes/codetree rebuild spawn).
//
// Own route module (mirrors routes/ack.ts) so the command-exec surface is
// unit-testable in isolation. Auth is NOT handled here: the central route-chain
// gate in web.ts 401s any non-public /api write before dispatch (same posture
// as every other internal write endpoint).
//
// Security boundary: `action` is a strict allowlist and `color` a strict hex
// regex, both validated BEFORE any spawn. The script is invoked via execFile
// with an argv array (never a shell string), so no input is ever interpolated
// into a command line -- a rejected input never reaches the spawn at all.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../../config.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const RGB_SCRIPT = join(PROJECT_ROOT, 'scripts', 'rgb-lights.sh')
const COLOR_RE = /^[0-9A-Fa-f]{6}$/
const EXEC_TIMEOUT_MS = 15000

// Injectable exec runner so route tests assert the exact argv passed to the
// spawn (mirrors codetree's __setCodetreeRebuildRunner). Production uses the
// real promisified execFile.
type ExecFileFn = (file: string, args: string[], opts: { timeout: number }) => Promise<unknown>
const realExecFile = promisify(execFile) as unknown as ExecFileFn
let execFileAsync: ExecFileFn = realExecFile

export function __setRgbExecFile(fn: ExecFileFn): void {
  execFileAsync = fn
}
export function __resetRgbExecFile(): void {
  execFileAsync = realExecFile
}

export async function tryHandleRgb(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/rgb/lights') return false
  if (method !== 'POST') return false // only POST is defined; let other methods 404

  const raw = (await readBody(req)).toString().trim()
  let parsed: { action?: unknown; color?: unknown }
  try {
    parsed = raw ? (JSON.parse(raw) as { action?: unknown; color?: unknown }) : {}
  } catch {
    json(res, { ok: false, error: 'invalid JSON' }, 400)
    return true
  }

  // Strict action allowlist -- anything else is 400 with NO spawn.
  const action = parsed.action
  if (action !== 'off' && action !== 'on') {
    json(res, { ok: false, error: 'action must be "off" or "on"' }, 400)
    return true
  }

  // Optional color: when present it must be exactly 6 hex digits. When absent
  // the script applies its own default (FF0000).
  let color: string | undefined
  if (parsed.color !== undefined && parsed.color !== null) {
    if (typeof parsed.color !== 'string' || !COLOR_RE.test(parsed.color)) {
      json(res, { ok: false, error: 'color must be a 6-digit hex string (RRGGBB)' }, 400)
      return true
    }
    color = parsed.color
  }

  // argv array -> no shell, no interpolation. Both elements are already
  // validated against the allowlist/regex above.
  const argv = [RGB_SCRIPT, action, ...(color ? [color] : [])]
  try {
    await execFileAsync('bash', argv, { timeout: EXEC_TIMEOUT_MS })
    json(res, { ok: true, action, color: color ?? null })
  } catch (err) {
    // The script's stdout is unreliable (OpenRGB is a GUI subsystem, no readable
    // output) -- we never assert on it; only a spawn/exec failure maps to 500.
    const message = err instanceof Error ? err.message : String(err)
    json(res, { ok: false, error: message }, 500)
  }
  return true
}
