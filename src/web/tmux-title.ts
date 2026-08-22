// Self-updating tmux WINDOW title = agent id + live state (idle/busy/ctx%), so
// the fleet is legible at-a-glance INSIDE tmux (card b83e7c92 item-2). This is
// the counterpart to the dashboard badge for anyone living in a terminal: the
// window title renders in tmux's status bar and window list even on a headless/
// detached pane, exactly where a custom in-pane statusLine does NOT render
// (statusline-headless-tmux-no-render lesson).
//
// Two layers: a pure title formatter (the part most likely to drift, fully unit
// tested) and a best-effort IO sweep behind a dependency seam. The sweep reuses
// the same signals everything else does -- pane-state.ts for idle/busy and
// contextPercentForModel for the window-relative percent -- so the title never
// disagrees with the watchdogs.

import { execFile } from 'node:child_process'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import {
  listAgentNames,
  readAgentModel,
  contextPercentForModel,
} from './agent-config.js'
import { agentSessionName, isAgentRunning } from './agent-process.js'
import { latestContextTokens } from './session-size-watcher.js'
import { detectPaneState, type PaneState } from '../pane-state.js'

const TMUX = resolveFromPath('tmux')

// Short human label per pane state. Kept to the pane-state vocabulary on
// purpose: a distinct 'wedged' label depends on the terminal-state detector
// (card b83e7c92 item-4) and is a deliberate fast-follow, not faked here.
const STATE_LABEL: Record<PaneState, string> = {
  idle: 'idle',
  busy: 'busy',
  typing: 'typing',
  unknown: 'unknown',
  error: 'error',
}

/**
 * Build the tmux window title. Pure. `ctxPercent` is appended only when > 0
 * (a 0 means we could not read the token count, and a bare state reads cleaner
 * than a misleading "0%"). The percent is assumed already clamped to [0,100]
 * by contextPercentForModel; the formatter renders it verbatim.
 */
export function formatWindowTitle(
  agentName: string,
  state: PaneState | null,
  ctxPercent: number,
): string {
  const label = state ? STATE_LABEL[state] : 'unknown'
  const base = `${agentName} ${label}`
  return ctxPercent > 0 ? `${base} ${ctxPercent}%` : base
}

/** tmux argv: rename the session's current window to `title`. */
export function renameWindowArgs(session: string, title: string): string[] {
  return ['rename-window', '-t', session, title]
}

/**
 * tmux argv: turn OFF automatic-rename for the window. tmux re-derives the
 * window name from the running process on the next pane event unless this is
 * off, which would otherwise stomp our title moments after we set it.
 */
export function disableAutoRenameArgs(session: string): string[] {
  return ['set-window-option', '-t', session, 'automatic-rename', 'off']
}

// Side effects the sweep depends on, behind a seam so updateAgentWindowTitle is
// unit-testable without spawning tmux or reading transcripts.
export interface TitleDeps {
  running: (name: string) => boolean
  capture: (session: string) => Promise<string | null>
  tokens: (name: string) => number | null
  model: (name: string) => string
  run: (args: string[]) => void
}

// Capture a pane snapshot via ASYNC execFile -- NOT execFileSync. This sweep
// runs often (30s); a synchronous capture-per-agent would block the dashboard
// event loop for the sum of all tmux round-trips on every tick. Null on any
// error so the caller renders 'unknown' rather than guessing.
function capturePaneAsync(session: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      TMUX,
      ['capture-pane', '-t', session, '-p'],
      { timeout: 3000, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    )
  })
}

// Fire a tmux command and forget it: a failed rename (e.g. the session died
// between the running-check and the rename) is logged at debug and swallowed --
// the title is a convenience, never load-bearing.
function tmuxFireAndForget(args: string[]): void {
  execFile(TMUX, args, { timeout: 5000 }, (err) => {
    if (err) logger.debug({ err, args }, 'tmux-title: command failed')
  })
}

const defaultDeps: TitleDeps = {
  running: isAgentRunning,
  capture: capturePaneAsync,
  tokens: latestContextTokens,
  model: readAgentModel,
  run: tmuxFireAndForget,
}

/**
 * Refresh one agent's tmux window title from its live pane state + context
 * usage. Best-effort and no-op for a stopped agent. The window size comes from
 * the CONFIGURED model (readAgentModel) so a 1M-context Opus is sized at 1M,
 * matching the context-window watchdog (transcript-model-drops-1m-suffix).
 */
export async function updateAgentWindowTitle(
  name: string,
  deps: TitleDeps = defaultDeps,
): Promise<void> {
  if (!deps.running(name)) return
  const session = agentSessionName(name)
  const pane = await deps.capture(session)
  const state: PaneState | null = pane ? detectPaneState(pane) : null
  const percent = contextPercentForModel(deps.tokens(name) ?? 0, deps.model(name))
  const title = formatWindowTitle(name, state, percent)
  deps.run(disableAutoRenameArgs(session))
  deps.run(renameWindowArgs(session, title))
}

// Offset from the other watchers (channel-monitor 30s, channel-health 45s,
// stuck-input 20s, stuck-tool-call 35s, session-size 10min) -- a snappy enough
// cadence for an at-a-glance state label without adding meaningful tmux load.
const INTERVAL_MS = 30 * 1000

/**
 * Start the periodic title sweep. Sequential per agent: the `await` on each
 * async capture yields the event loop between agents, so the (cheap, cached)
 * token read for one agent never piles up behind 15 others. Returns the timer
 * (unref'd) so it never keeps the process alive on its own.
 */
export function startTmuxTitleWatcher(): NodeJS.Timeout {
  async function sweep(): Promise<void> {
    for (const name of listAgentNames()) {
      try {
        await updateAgentWindowTitle(name)
      } catch (err) {
        logger.debug({ err, agent: name }, 'tmux-title: sweep error')
      }
    }
  }
  void sweep()
  const interval = setInterval(() => void sweep(), INTERVAL_MS)
  if (typeof interval.unref === 'function') interval.unref()
  return interval
}
