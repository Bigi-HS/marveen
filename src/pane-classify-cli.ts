/**
 * pane-classify-cli -- thin CLI over pane-state.ts canonical detectors.
 *
 * BATCH mode (default):
 *   stdin:  JSON {agentName: paneCapture, ...}
 *   stdout: JSON {agentName: PaneClassifyState, ...}
 *
 * SINGLE mode (--pane flag):
 *   stdin:  raw pane capture text
 *   stdout: single PaneClassifyState token, newline-terminated, exit 0 always
 *
 * State priority: limit > survey > enter > login > idle | busy | unknown
 *
 * Fail-safe contract (SINGLE mode):
 *   - Always exits 0 and writes exactly one token.
 *   - On any error/uncertainty: 'unknown', NEVER 'survey'.
 *   - The dangerous direction is a false-positive auto-dismiss (e167dd08 TOCTOU).
 *     The safe direction is an abort. So we never emit 'survey' in doubt.
 *
 * card c72ec834
 */
import { detectsUsageLimitMenu, detectsFeedbackModal, detectsActiveLoginBox, detectPaneState } from './pane-state.js'

export type PaneClassifyState = 'limit' | 'survey' | 'enter' | 'login' | 'idle' | 'busy' | 'unknown'

// Press-Enter stuck detection. No dedicated TS fn in pane-state.ts yet -- this
// file is the canonical source. Tail-scoped (same depth as survey) so a
// dismissed "Press Enter" prompt that scrolled off does not keep firing.
const ENTER_TAIL_LINES = 10
const ENTER_STUCK_RX = /press enter/i

export function classifyPane(pane: string, nowMs?: number): PaneClassifyState {
  try {
    if (!pane || !pane.trim()) return 'unknown'
    if (detectsUsageLimitMenu(pane, nowMs)) return 'limit'
    if (detectsFeedbackModal(pane)) return 'survey'
    const tail = pane.split('\n').slice(-ENTER_TAIL_LINES).join('\n')
    if (ENTER_STUCK_RX.test(tail)) return 'enter'
    if (detectsActiveLoginBox(pane)) return 'login'
    const ps = detectPaneState(pane, nowMs !== undefined ? { nowMs } : {})
    if (ps === 'idle') return 'idle'
    if (ps === 'busy' || ps === 'typing') return 'busy'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  if (process.argv.includes('--pane')) {
    let state: PaneClassifyState = 'unknown'
    try {
      state = classifyPane(await readStdin())
    } catch {
      state = 'unknown'
    }
    process.stdout.write(state + '\n')
    process.exit(0)
    return
  }

  // BATCH mode
  let raw: string
  try {
    raw = await readStdin()
  } catch (err) {
    process.stderr.write(`pane-classify-cli: stdin read error: ${err}\n`)
    process.exit(1)
    return
  }

  let input: Record<string, unknown>
  try {
    input = JSON.parse(raw) as Record<string, unknown>
  } catch {
    process.stderr.write('pane-classify-cli: invalid JSON on stdin\n')
    process.exit(1)
    return
  }

  const result: Record<string, PaneClassifyState> = {}
  for (const [agent, pane] of Object.entries(input)) {
    result[agent] = classifyPane(typeof pane === 'string' ? pane : '')
  }
  process.stdout.write(JSON.stringify(result) + '\n')
}

main().catch(() => {
  process.exit(1)
})
