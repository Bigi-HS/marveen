import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideLaunchRetry, shouldContinueSession, decideResumeMenuAction } from '../web/agent-process.js'

const SEP = '─'.repeat(80)
const IDLE_PANE = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
const BUSY_PANE = ['✢ Combobulating… (52s · ↓ 2.6k tokens · thinking)', '', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt'].join('\n')
const RESUME_MENU_PANE = ['Resume from summary', '1. Resume from summary (recommended)', '2. Start fresh', SEP, 'Enter to confirm'].join('\n')

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

// Pure continue-vs-fresh decision. The first attempt resumes the prior session;
// any retry (after a liveness-window death, the stale deferred-tool-marker case)
// drops --continue and boots fresh. A brand-new agent never resumes at all.
describe('shouldContinueSession', () => {
  it('resumes on the first attempt when a prior session exists', () => {
    expect(shouldContinueSession(true, 0)).toBe(true)
  })

  it('drops --continue on the retry attempt (fresh-session fallback)', () => {
    expect(shouldContinueSession(true, 1)).toBe(false)
  })

  it('never resumes when there is no prior session, on any attempt', () => {
    expect(shouldContinueSession(false, 0)).toBe(false)
    expect(shouldContinueSession(false, 1)).toBe(false)
  })
})

// Pure resume-menu decision driving the non-blocking watcher: dismiss while the
// resume-from-summary modal is up, report ready once the prompt is idle, wait
// (keep polling) otherwise or when the pane could not be captured.
describe('decideResumeMenuAction', () => {
  it('waits when the pane capture failed (null)', () => {
    expect(decideResumeMenuAction(null)).toBe('wait')
  })

  it('dismisses while the resume-from-summary modal is visible', () => {
    expect(decideResumeMenuAction(RESUME_MENU_PANE)).toBe('dismiss')
  })

  it('reports ready once the prompt is idle', () => {
    expect(decideResumeMenuAction(IDLE_PANE)).toBe('ready')
  })

  it('waits while the session is still busy (no modal, not idle)', () => {
    expect(decideResumeMenuAction(BUSY_PANE)).toBe('wait')
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

  it('decides the --continue flag per attempt via shouldContinueSession', () => {
    expect(SRC).toMatch(/shouldContinueSession\(hasPriorSession,\s*attempt\)/)
  })

  it('rebuilds the launch command inside the loop so a retry can drop --continue', () => {
    expect(SRC).toMatch(/const cmd = buildLaunchCmd\(useContinue \? '--continue ' : ''\)/)
  })

  it('settles after tearing down a dead attempt so the retry avoids the config-dir lock race', () => {
    expect(SRC).toMatch(/LAUNCH_RETRY_SETTLE_S/)
    expect(SRC).toMatch(/sleep \$\{LAUNCH_RETRY_SETTLE_S\}/)
  })
})
