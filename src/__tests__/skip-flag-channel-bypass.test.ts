import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeSkipFlag } from '../web/profiles.js'

// Card b407711f (durable fix behind Boss complaint, interim af398086/PR#345).
// A strict profile normally drops --dangerously-skip-permissions so Claude Code
// enforces the allow/deny list. But a CHANNEL agent (Telegram/Slack/Discord)
// must KEEP the bypass: without it an interactive permission prompt surfaces on
// the channel after a restart (a prompt leaked to Telegram -- Dominik complaint)
// and the callback stalls waiting for an approval no one can give there. So the
// flag is dropped ONLY for a strict profile with NO channel.
const SKIP = '--dangerously-skip-permissions '

describe('computeSkipFlag -- channel agents keep the bypass even under a strict profile', () => {
  it('drops the flag for a strict profile with NO channel (allow/deny enforced)', () => {
    expect(computeSkipFlag('strict', false)).toBe('')
  })

  it('KEEPS the flag for a strict profile WITH a channel (the fix -- no prompt leak)', () => {
    expect(computeSkipFlag('strict', true)).toBe(SKIP)
  })

  it('keeps the flag for a permissive profile with no channel', () => {
    expect(computeSkipFlag('permissive', false)).toBe(SKIP)
  })

  it('keeps the flag for a permissive profile with a channel', () => {
    expect(computeSkipFlag('permissive', true)).toBe(SKIP)
  })
})

// The pure function is only load-bearing if the launch path actually calls it
// with the live (permissionMode, hasChannel) pair. Pin the wiring so a revert
// to the old channel-blind `permissionMode === 'strict' ? '' : ...` at the
// launch site is caught.
const PROCESS_SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

describe('startAgentProcess -- skipFlag wiring', () => {
  it('computes skipFlag via computeSkipFlag(profile.permissionMode, hasChannel)', () => {
    expect(PROCESS_SRC).toMatch(/const skipFlag = computeSkipFlag\(profile\.permissionMode,\s*hasChannel\)/)
  })

  it('no longer decides the flag inline from permissionMode alone (channel-blind regression guard)', () => {
    expect(PROCESS_SRC).not.toMatch(/skipFlag = profile\.permissionMode === 'strict' \? '' :/)
  })
})
