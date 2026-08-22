import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Integration test: the status line is a standalone python3 script (no jq on the
// host), so we exercise it the way Claude Code does -- pipe a JSON payload on
// stdin and inspect stdout. Asserting on the rendered text keeps the port honest.

const SCRIPT = resolve(process.cwd(), 'scripts/genesis-statusline.py')

function render(payload: unknown, env?: Record<string, string>): { raw: string; plain: string } {
  const raw = execFileSync('python3', [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
  // strip ANSI SGR codes so assertions read the human-visible text
  const plain = raw.replace(/\x1b\[[0-9;]*m/g, '')
  return { raw, plain }
}

const REPO_ROOT = process.cwd()

describe('genesis-statusline', () => {
  it('renders model, context bar, percentage, token count, cost', () => {
    const { plain } = render({
      model: { display_name: 'Opus' },
      context_window: { used_percentage: 42, context_window_size: 200000 },
      cost: { total_cost_usd: 0.1234 },
    })
    expect(plain).toContain('🤖 Opus')
    expect(plain).toContain('42%')
    expect(plain).toContain('(84k/200k)')
    expect(plain).toContain('$0.12')
    // 42% of a 20-char bar -> 8 filled cells (integer division)
    expect(plain).toContain('█'.repeat(8) + '░'.repeat(12))
  })

  it('scales token count to the actual context window size (1M)', () => {
    const { plain } = render({
      model: { display_name: 'Opus 1M' },
      context_window: { used_percentage: 88, context_window_size: 1000000 },
      cost: { total_cost_usd: 3.5 },
    })
    expect(plain).toContain('88%')
    expect(plain).toContain('(880k/1000k)')
    expect(plain).toContain('$3.50')
  })

  it('colors the bar green/yellow/red by fill (the balloon early-warning)', () => {
    const green = render({ context_window: { used_percentage: 20 } }).raw
    const yellow = render({ context_window: { used_percentage: 60 } }).raw
    const red = render({ context_window: { used_percentage: 90 } }).raw
    expect(green).toContain('\x1b[32m') // green
    expect(yellow).toContain('\x1b[33m') // yellow
    expect(red).toContain('\x1b[31m') // red
  })

  it('clamps percentage into [0,100]', () => {
    expect(render({ context_window: { used_percentage: 150 } }).plain).toContain('100%')
    expect(render({ context_window: { used_percentage: -5 } }).plain).toContain('0%')
  })

  it('treats a null/early used_percentage as 0% without crashing', () => {
    const { plain } = render({ model: { display_name: 'Sonnet' }, context_window: { used_percentage: null } })
    expect(plain).toContain('Sonnet')
    expect(plain).toContain('0%')
    expect(plain).toContain('(0k/200k)') // default 200k window
  })

  it('falls back to defaults on empty stdin', () => {
    const { plain } = render('')
    expect(plain).toContain('🤖 ?')
    expect(plain).toContain('0%')
    expect(plain).toContain('$0.00')
  })

  it('does not throw on malformed JSON (exits clean with defaults)', () => {
    const { plain } = render('not json{')
    expect(plain).toContain('0%')
  })

  it('shows a git branch segment when cwd is a repo', () => {
    const { plain } = render({ workspace: { current_dir: REPO_ROOT } })
    expect(plain).toContain('🌿')
  })

  it('omits the git segment when cwd is not a repo', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'sl-nogit-'))
    const { plain } = render({ workspace: { current_dir: nonRepo } })
    expect(plain).not.toContain('🌿')
  })

  it('defaults cost to $0.00 when absent', () => {
    expect(render({ model: { display_name: 'X' } }).plain).toContain('$0.00')
  })

  it('persists a rate_limits/context/cost snapshot to STATUSLINE_LAST_PATH (Delta1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-snap-'))
    const snapPath = join(dir, 'statusline-last.json')
    const { plain } = render(
      {
        model: { display_name: 'Opus' },
        context_window: { used_percentage: 50, context_window_size: 200000 },
        cost: { total_cost_usd: 1.23 },
        rate_limits: { five_hour: { used_percentage: 71, resets_at: 1893456000 } },
      },
      { STATUSLINE_LAST_PATH: snapPath },
    )
    // The status line still renders normally...
    expect(plain).toContain('50%')
    // ...and the snapshot is written with the fields the governor needs.
    const snap = JSON.parse(readFileSync(snapPath, 'utf-8'))
    expect(snap.rate_limits.five_hour.used_percentage).toBe(71)
    expect(snap.rate_limits.five_hour.resets_at).toBe(1893456000)
    expect(snap.context_window.used_percentage).toBe(50)
    expect(snap.cost.total_cost_usd).toBe(1.23)
    expect(typeof snap.captured_at).toBe('number')
  })

  it('a failed snapshot write never breaks the status line output', () => {
    // Point the snapshot at a path whose parent is a regular file, so the write
    // (and the makedirs) fails -- the status line must still render to stdout.
    const dir = mkdtempSync(join(tmpdir(), 'sl-snapfail-'))
    const filePath = join(dir, 'afile')
    render('', { STATUSLINE_LAST_PATH: filePath }) // create the file via a first run
    const blocked = join(filePath, 'statusline-last.json') // afile/... -> ENOTDIR
    const { plain } = render(
      { model: { display_name: 'Sonnet' }, context_window: { used_percentage: 30 } },
      { STATUSLINE_LAST_PATH: blocked },
    )
    expect(plain).toContain('Sonnet')
    expect(plain).toContain('30%')
  })
})
