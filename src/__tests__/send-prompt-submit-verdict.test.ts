import { describe, it, expect, beforeEach, vi } from 'vitest'

// sendPromptToSession is IO-bound (tmux send-keys + capture-pane), so the
// whole surface is driven through a mocked node:child_process. The pane the
// mock returns is swapped per test via `currentPane`; every capture-pane in
// one run therefore sees the same frame, which is exactly the live failure
// mode we care about (a parked draft does not clear on its own).
let currentPane: string | null = ''
const calls: string[][] = []

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    // resolveFromPath('tmux'|'claude') runs at module load; give it a hit.
    execSync: vi.fn((cmd: string) => `/usr/bin/${String(cmd).split(' ').pop()}\n`),
    execFileSync: vi.fn((_file: string, args?: readonly string[]) => {
      const argv = (args ?? []) as string[]
      calls.push(argv)
      if (argv.includes('capture-pane')) {
        if (currentPane === null) throw new Error('capture-pane failed')
        return currentPane
      }
      return ''
    }),
  }
})

const { sendPromptToSession } = await import('../web/agent-process.js')

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'

// No preamble markers in the payload: shouldClearTruncatedPreamble must not
// fire, so any Ctrl-U observed in a test is the post-send cleanup and nothing
// else. Longer than the 96-char payloadHint slice so the hint is a real
// substring of the parked box rather than the whole prompt.
const PROMPT =
  'Utemezett feladat torzs, elegendo hosszal ahhoz hogy a 96 karakteres payload-hint valodi reszlet legyen, nem a teljes szoveg.'

function idlePane(): string {
  return ['  output of the previous turn', '', SEP, '❯ ', SEP, FOOTER].join('\n')
}

function parkedPane(): string {
  return ['  output of the previous turn', '', SEP, `❯ ${PROMPT}`, SEP, FOOTER].join('\n')
}

function sendKeyCalls(key: string): string[][] {
  return calls.filter(c => c.includes('send-keys') && c.includes(key))
}

describe('sendPromptToSession submit verdict', () => {
  beforeEach(() => {
    calls.length = 0
    currentPane = ''
  })

  it('returns "submitted" when the composer is empty after the trailing Enter', () => {
    currentPane = idlePane()

    expect(sendPromptToSession('agent-test', PROMPT)).toBe('submitted')
    // Nothing to clean up: the prompt landed.
    expect(sendKeyCalls('C-u')).toHaveLength(0)
  })

  it('returns "parked" when the prompt is still sitting in the composer after the retry budget', () => {
    currentPane = parkedPane()

    expect(sendPromptToSession('agent-test', PROMPT)).toBe('parked')
  })

  it('clears its own residue when the submit never lands, so the pane is not poisoned for the next send', () => {
    // Regression guard (card CORE/57cf5022): the un-submitted draft left in
    // the composer is what makes every LATER prompt to this agent read as
    // busy forever. The sender must take its own text back out.
    currentPane = parkedPane()

    sendPromptToSession('agent-test', PROMPT)

    expect(sendKeyCalls('C-u').length).toBeGreaterThan(0)
  })

  it('returns "unknown" (not "parked") when the pane cannot be captured -- and clears nothing', () => {
    // A failed capture proves nothing: the prompt may well have landed.
    // Clearing here would destroy a live draft, and reporting "parked"
    // would re-run a task that already ran. Unknown must stay unknown.
    currentPane = null

    expect(sendPromptToSession('agent-test', PROMPT)).toBe('unknown')
    expect(sendKeyCalls('C-u')).toHaveLength(0)
  })
})
