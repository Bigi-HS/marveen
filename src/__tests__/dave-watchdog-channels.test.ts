/**
 * Static-assertion tests for scripts/dave-watchdog.sh (card a87a2398).
 *
 * Dave is a CHANNEL agent (@DAVE_KALOZ_BOT). The old watchdog relaunched him
 * with `--continue` and NO `--channels`, so any watchdog-driven restart
 * (crash / 429) left Dave channel-less: he stopped receiving Boss-DM. The fix
 * mirrors thor-watchdog.sh: ALWAYS relaunch FRESH with --channels +
 * TELEGRAM_STATE_DIR. Dave's durable state lives in the memory system, so a
 * fresh session is safe (context loss is minimal).
 *
 * These are STRUCTURAL tests: they grep the real script for the required
 * patterns (and the ABSENCE of the old broken `--continue` pattern) without
 * executing it. Mental-revert evidence: reintroducing `--continue` or dropping
 * `--channels` / TELEGRAM_STATE_DIR would fail one of these.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(__dirname, '../../scripts/dave-watchdog.sh')

function readScript(): string {
  return readFileSync(SCRIPT_PATH, 'utf-8')
}

describe('dave-watchdog.sh -- channel-aware relaunch (card a87a2398)', () => {
  // DoD-1: the relaunch activates Dave's Telegram channel.
  it('DoD-1: launches with --channels plugin:telegram@claude-plugins-official', () => {
    expect(readScript()).toMatch(/--channels plugin:telegram@claude-plugins-official/)
  })

  // DoD-2: the relaunch points the channels plugin at Dave's own state dir, so
  // the channel pairing/allowlist state survives the restart (mirrors thor).
  it('DoD-2: exports TELEGRAM_STATE_DIR for the channel session', () => {
    const src = readScript()
    expect(src).toMatch(/export TELEGRAM_STATE_DIR=/)
    // STATE must resolve to Dave's telegram channels dir.
    expect(src).toMatch(/\.claude\/channels\/telegram/)
  })

  // DoD-3 (the core bug, mental-revert): NO claude invocation passes --continue.
  // A --continue relaunch is what drops the --channels activation; if it is
  // reintroduced on a launch line this test fails. (Prose comments may still
  // explain WHY --continue was removed, so we only scan claude-invocation lines.)
  it('DoD-3: no claude invocation relaunches with --continue', () => {
    const claudeLines = readScript()
      .split('\n')
      .filter((l) => l.includes('/usr/bin/claude'))
    expect(claudeLines.length).toBeGreaterThan(0)
    for (const line of claudeLines) {
      expect(line).not.toMatch(/--continue/)
    }
  })

  // DoD-4: the launch waits for the channel-listening surface before returning,
  // so a parked first-run dialog is auto-answered instead of silently hanging.
  it('DoD-4: guards on the channel-listening surface after launch', () => {
    expect(readScript()).toMatch(/Listening for channel messages/)
  })

  // DoD-5: the global TELEGRAM_BOT_TOKEN is cleared (tmux + env) so the plugin
  // reads its token from the channel state, not a stale inherited env var
  // (parity with thor-watchdog).
  it('DoD-5: clears the inherited TELEGRAM_BOT_TOKEN (tmux global + unset)', () => {
    const src = readScript()
    expect(src).toMatch(/tmux set-environment -g -u TELEGRAM_BOT_TOKEN/)
    expect(src).toMatch(/unset TELEGRAM_BOT_TOKEN/)
  })

  // DoD-6: the old resume-menu / launch_fresh split is gone. With --continue
  // removed there is no resume menu to answer and no fresh-vs-continue branch.
  it('DoD-6: no leftover resume-menu answering or launch_fresh split', () => {
    const src = readScript()
    expect(src).not.toMatch(/answer_resume_prompt/)
    expect(src).not.toMatch(/launch_fresh/)
  })

  // DoD-7: the crash-loop alert path is preserved -- repeated sub-threshold
  // deaths still notify marveen (the signal is independent of --continue).
  it('DoD-7: keeps the crash-loop alert to marveen', () => {
    const src = readScript()
    expect(src).toMatch(/alert_crash_loop/)
    expect(src).toMatch(/CRASH-LOOP/)
  })
})
