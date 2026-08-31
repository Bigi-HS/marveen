import { describe, it, expect, vi } from 'vitest'
import {
  formatWindowTitle,
  renameWindowArgs,
  disableAutoRenameArgs,
  updateAgentWindowTitle,
  type TitleDeps,
} from '../web/tmux-title.js'

// Card b83e7c92 item-2: the agent's tmux WINDOW title carries its identity +
// live state (idle/busy/ctx%) so the fleet is legible at-a-glance inside tmux,
// where a custom in-pane statusLine does not render in a headless/detached pane
// (statusline-headless-tmux-no-render lesson). The title string is built by a
// pure formatter; the tmux side effects sit behind a dependency seam.

describe('formatWindowTitle', () => {
  it('joins agent + state, appending ctx% when positive', () => {
    expect(formatWindowTitle('dave', 'busy', 47)).toBe('dave busy 47%')
    expect(formatWindowTitle('scout', 'idle', 3)).toBe('scout idle 3%')
  })
  it('omits ctx% when zero or negative (unknown token count)', () => {
    expect(formatWindowTitle('dave', 'idle', 0)).toBe('dave idle')
    expect(formatWindowTitle('dave', 'idle', -5)).toBe('dave idle')
  })
  it('maps every pane state to a label', () => {
    expect(formatWindowTitle('a', 'idle', 0)).toBe('a idle')
    expect(formatWindowTitle('a', 'busy', 0)).toBe('a busy')
    expect(formatWindowTitle('a', 'typing', 0)).toBe('a typing')
    expect(formatWindowTitle('a', 'unknown', 0)).toBe('a unknown')
    expect(formatWindowTitle('a', 'error', 0)).toBe('a error')
  })
  it('treats a null state (capture failed) as unknown', () => {
    expect(formatWindowTitle('dave', null, 0)).toBe('dave unknown')
  })
  it('clamps a >100 ctx% into the title verbatim (formatter does not re-clamp; caller pre-clamps)', () => {
    // contextPercentForModel already clamps to [0,100]; the formatter only
    // gates on >0, so it should faithfully render whatever it is handed.
    expect(formatWindowTitle('dave', 'busy', 100)).toBe('dave busy 100%')
  })
})

describe('renameWindowArgs / disableAutoRenameArgs', () => {
  it('builds the tmux rename-window argv for the session (OPS-110: anchored =NAME: target)', () => {
    expect(renameWindowArgs('agent-dave', 'dave busy 47%')).toEqual([
      'rename-window', '-t', '=agent-dave:', 'dave busy 47%',
    ])
  })
  it('builds the automatic-rename off argv (so our name is not overwritten)', () => {
    expect(disableAutoRenameArgs('agent-dave')).toEqual([
      'set-window-option', '-t', '=agent-dave:', 'automatic-rename', 'off',
    ])
  })
})

function fakeDeps(over: Partial<TitleDeps> = {}): TitleDeps {
  return {
    running: () => true,
    capture: async () => 'esc to interrupt', // looks busy
    tokens: () => null,
    model: () => 'claude-sonnet-4-6',
    run: vi.fn(),
    ...over,
  }
}

describe('updateAgentWindowTitle', () => {
  it('does nothing for a stopped agent', async () => {
    const run = vi.fn()
    await updateAgentWindowTitle('dave', fakeDeps({ running: () => false, run }))
    expect(run).not.toHaveBeenCalled()
  })

  it('renames the window to agent + derived state + ctx%', async () => {
    const run = vi.fn()
    // 100k tokens on a 200k window -> 50%.
    await updateAgentWindowTitle('dave', fakeDeps({
      capture: async () => '⏵ tool running … (esc to interrupt)',
      tokens: () => 100_000,
      model: () => 'claude-sonnet-4-6',
      run,
    }))
    // disable auto-rename first, then rename.
    expect(run).toHaveBeenCalledWith(['set-window-option', '-t', '=agent-dave:', 'automatic-rename', 'off'])
    expect(run).toHaveBeenCalledWith(['rename-window', '-t', '=agent-dave:', 'dave busy 50%'])
  })

  it('falls back to unknown state when the pane capture fails', async () => {
    const run = vi.fn()
    await updateAgentWindowTitle('dave', fakeDeps({ capture: async () => null, tokens: () => null, run }))
    expect(run).toHaveBeenCalledWith(['rename-window', '-t', '=agent-dave:', 'dave unknown'])
  })
})
