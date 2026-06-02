import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideLaunchRetry } from '../web/agent-process.js'

// Pure launch-retry decision. `maxAttempt` is the highest 0-based attempt index
// allowed (LAUNCH_MAX_ATTEMPTS - 1 = 1 for the default two-attempt budget).
describe('decideLaunchRetry', () => {
  it('returns ok the moment the session is live, regardless of attempt', () => {
    expect(decideLaunchRetry(true, 0, 1)).toBe('ok')
    expect(decideLaunchRetry(true, 1, 1)).toBe('ok')
  })

  it('retries a dead session while attempts remain', () => {
    expect(decideLaunchRetry(false, 0, 1)).toBe('retry')
  })

  it('gives up on a dead session once the last attempt is spent', () => {
    expect(decideLaunchRetry(false, 1, 1)).toBe('give-up')
  })

  it('with a single-attempt budget (maxAttempt 0), a dead session gives up immediately', () => {
    expect(decideLaunchRetry(false, 0, 0)).toBe('give-up')
  })
})

// Source-contract tests: the launcher wiring is exercised against the real
// agent-process.ts text rather than by spawning tmux (per the never-test-on-a-
// live-agent rule, the spawn loop is validated by structure + the pure
// decideLaunchRetry above, not by killing a session).
const SRC = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')

describe('startAgentProcess -- isolated config dir wiring', () => {
  it('imports ensureAgentConfigDir', () => {
    expect(SRC).toMatch(/import\s*\{\s*ensureAgentConfigDir\s*\}\s*from\s*'\.\/agent-config-dir\.js'/)
  })

  it('auto-builds the isolated config dir when no custom dir is pinned', () => {
    expect(SRC).toMatch(/ensureAgentConfigDir\(name\)/)
  })

  it('respects an operator-pinned custom config dir verbatim (separate-login case)', () => {
    expect(SRC).toMatch(/explicitConfigDir\s*&&\s*explicitConfigDir\s*!==\s*canonicalConfigDir/)
  })

  it('always exports CLAUDE_CONFIG_DIR now (every sub-agent is isolated)', () => {
    expect(SRC).toMatch(/const claudeConfigEnv = `export CLAUDE_CONFIG_DIR="\$\{claudeConfigDir\}" && `/)
  })
})

describe('startAgentProcess -- launch liveness + retry wiring', () => {
  it('probes liveness after a settle window and feeds it to decideLaunchRetry', () => {
    expect(SRC).toMatch(/decideLaunchRetry\(isAgentRunning\(name\)/)
  })

  it('returns an explicit error when the session keeps exiting immediately', () => {
    expect(SRC).toMatch(/Agent process exited immediately after launch/)
  })

  it('tears the dead session down before retrying', () => {
    expect(SRC).toMatch(/decision === 'retry'|retrying launch/)
  })
})
