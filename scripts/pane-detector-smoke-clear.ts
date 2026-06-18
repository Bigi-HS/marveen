#!/usr/bin/env tsx
// Clear the pane-detector drift gate after a c12 pane-detector smoke PASSES on a
// new Claude Code CLI version (card 56ad0fa3 / B1). Records the validated version
// and removes the mismatch flag, re-enabling the pane-dependent wedge watchdogs
// (stuck-input, stuck-tool-call, wedged-queue) that stood down on the drift.
//
//   tsx scripts/pane-detector-smoke-clear.ts            # use `claude --version`
//   tsx scripts/pane-detector-smoke-clear.ts 2.5.0      # explicit version
//
// Run this ONLY after the pane-detector smoke actually passed on the new CLI --
// it is the human/c12 gate that the drift watch deliberately does not auto-clear.

import { execFileSync } from 'node:child_process'
import {
  recordPaneDetectorSmokePass,
  readPaneDetectorGate,
} from '../src/web/pane-detector-gate.js'

function detectCliVersion(): string | null {
  try {
    const out = execFileSync('claude', ['--version'], { encoding: 'utf-8', timeout: 10_000 })
    const m = out.match(/[0-9]+\.[0-9]+\.[0-9]+/)
    return m ? m[0] : null
  } catch {
    return null
  }
}

function main(): void {
  const argv = process.argv[2]?.trim()
  const version = argv && argv.length > 0 ? argv : detectCliVersion()
  if (!version) {
    console.error('pane-detector-smoke-clear: could not determine CLI version (pass it explicitly: tsx scripts/pane-detector-smoke-clear.ts <version>)')
    process.exit(1)
  }
  const before = readPaneDetectorGate()
  recordPaneDetectorSmokePass(version)
  const after = readPaneDetectorGate()
  console.log(`pane-detector smoke recorded for CLI ${version}`)
  console.log(`gate: ${before.trusted ? 'trusted' : 'NOT trusted'} -> ${after.trusted ? 'trusted' : 'NOT trusted'} (${after.reason})`)
}

main()
