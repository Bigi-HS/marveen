#!/usr/bin/env tsx
// Automated pane-detector smoke for C12 (Buster). Card ed8982c7 / B2.
//
// Runs as a Buster scheduled heartbeat. When the fleet-supervisor detects a
// CLI drift it writes cli-version-mismatch.txt and the pane-dependent
// watchdogs stand down. This script checks for that condition and, if active,
// runs a live pane-state probe against the agent-buster tmux session to
// verify the detector still reads the new CLI correctly. On PASS it clears
// the gate; on FAIL it fires an inter-agent alert to NoA so a human can
// investigate before watchdogs are re-enabled.
//
// Usage (called by the Buster heartbeat prompt):
//   tsx scripts/c12-pane-detector-auto-smoke.ts
//
// Silent exit 0 when the gate is already trusted (no drift active).

import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_ROOT = join(import.meta.dirname, '..')
const STORE = join(PROJECT_ROOT, 'store')
const STATE_DIR = join(STORE, '.fleet-supervisor')
const MISMATCH_FILE = join(STATE_DIR, 'cli-version-mismatch.txt')
const SMOKE_PASSED_FILE = join(STATE_DIR, 'cli-smoke-passed.txt')
const DASHBOARD_TOKEN_FILE = join(STORE, '.dashboard-token')
const DASHBOARD_URL = 'http://localhost:3420'
const BUSTER_SESSION = 'agent-buster'

function readTrimmed(path: string): string | null {
  try {
    const v = readFileSync(path, 'utf-8').trim()
    return v.length > 0 ? v : null
  } catch {
    return null
  }
}

function isDriftActive(): string | null {
  const mismatch = readTrimmed(MISMATCH_FILE)
  if (!mismatch) return null
  const smokePassed = readTrimmed(SMOKE_PASSED_FILE)
  // Gate trusted when smoke already passed for this exact version
  if (smokePassed && smokePassed === mismatch) return null
  return mismatch
}

function getCurrentCliVersion(): string | null {
  try {
    const out = execFileSync('claude', ['--version'], { encoding: 'utf-8', timeout: 10_000 })
    const m = out.match(/[0-9]+\.[0-9]+\.[0-9]+/)
    return m ? m[0] : null
  } catch {
    return null
  }
}

function captureBusterPane(): string | null {
  try {
    const out = execFileSync('tmux', ['capture-pane', '-p', '-t', BUSTER_SESSION],
      { encoding: 'utf-8', timeout: 5_000 })
    return out
  } catch {
    return null
  }
}

// Lightweight structural probe: the pane must show a recognisable Claude Code
// idle or busy surface (footer or spinner). 'unknown' / null indicates the
// pane-state detector cannot parse the new CLI rendering -- FAIL.
function probePaneDetector(pane: string): { state: string; pass: boolean } {
  // Inline the two-tier check that pane-state.ts uses for 'idle' vs 'busy'
  // without importing from src/ (avoids tsx resolution issues at runtime).
  const idleBypassRx = /bypass permissions on/
  const idleStrictRx = /auto-approve: off/
  const busyEscRx = /esc to interrupt/i
  const busySpinnerRx = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒⠏⠛⠹⠸⠼⠴⠦⠧]|Thinking\.\.\./
  const busyTokenRx = /\d+k?\s*(input|output|tokens)/i

  const tail = pane.split('\n').slice(-30).join('\n')

  if (idleBypassRx.test(tail) || idleStrictRx.test(tail)) {
    return { state: 'idle', pass: true }
  }
  if (busyEscRx.test(tail) || busySpinnerRx.test(tail) || busyTokenRx.test(tail)) {
    return { state: 'busy', pass: true }
  }
  return { state: 'unknown', pass: false }
}

function sendInterAgent(content: string): void {
  try {
    const token = readTrimmed(DASHBOARD_TOKEN_FILE)
    if (!token) return
    const body = JSON.stringify({ from: 'buster', to: 'marveen', content })
    execSync(
      `curl -s -X POST ${DASHBOARD_URL}/api/messages ` +
      `-H "Content-Type: application/json" ` +
      `-H "Authorization: Bearer ${token}" ` +
      `--data-binary @-`,
      { input: body, timeout: 10_000, encoding: 'utf-8' }
    )
  } catch {
    // non-fatal: verdict still logged to stdout
  }
}

function clearGate(version: string): void {
  const tsx = join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx')
  execFileSync(tsx, [join(PROJECT_ROOT, 'scripts', 'pane-detector-smoke-clear.ts'), version],
    { timeout: 15_000, encoding: 'utf-8', stdio: 'pipe' })
}

function main(): void {
  const driftVersion = isDriftActive()
  if (!driftVersion) {
    // Gate trusted, nothing to do.
    process.exit(0)
  }

  console.log(`[c12-auto-smoke] CLI drift detected: ${driftVersion}. Running pane-detector probe.`)

  const cliVersion = getCurrentCliVersion()
  if (!cliVersion) {
    const msg = `C12 auto-smoke ABORT: could not get current CLI version (claude --version failed). Drift gate remains UNTRUSTED for ${driftVersion}.`
    console.error(msg)
    sendInterAgent(msg)
    process.exit(1)
  }

  if (cliVersion !== driftVersion) {
    const msg = `C12 auto-smoke SKIP: drift version (${driftVersion}) != current CLI (${cliVersion}). May be a stale mismatch file. Reporting to NoA.`
    console.warn(msg)
    sendInterAgent(msg)
    process.exit(0)
  }

  const pane = captureBusterPane()
  if (!pane) {
    const msg = `C12 auto-smoke FAIL: could not capture ${BUSTER_SESSION} tmux pane. Gate remains UNTRUSTED for CLI ${driftVersion}.`
    console.error(msg)
    sendInterAgent(msg)
    process.exit(1)
  }

  const { state, pass } = probePaneDetector(pane)
  if (pass) {
    try {
      clearGate(cliVersion)
      const msg = `C12 auto-smoke PASS: pane-detector probe returned '${state}' on CLI ${cliVersion}. Gate cleared. Watchdogs re-enabled.`
      console.log(msg)
      sendInterAgent(msg)
    } catch (err) {
      const msg = `C12 auto-smoke PASS but gate-clear FAILED: ${(err as Error).message}. Manual tsx scripts/pane-detector-smoke-clear.ts ${cliVersion} needed.`
      console.error(msg)
      sendInterAgent(msg)
      process.exit(1)
    }
  } else {
    const msg = `C12 auto-smoke FAIL: pane-detector returned '${state}' for CLI ${driftVersion}. Pane rendering may have changed. Gate stays UNTRUSTED. Manual investigation required before clearing.`
    console.error(msg)
    sendInterAgent(msg)
    process.exit(1)
  }
}

main()
