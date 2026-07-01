/**
 * Staleness-guard tests for scripts/hooks/hot-cache-sessionstart.py (card fedb4b5f, Phase 1).
 *
 * The SessionStart hook injects each agent's own .claude/hot-cache.md as
 * "current context". When that file freezes (marveen's was 8 days stale on
 * 06-22), the hook injected an OLD task as if fresh -> the agent anchored to
 * stale work and "forgot" what it was actually doing. Boss 06-30: fix fleet-wide.
 *
 * Phase 1 = staleness-guard: if hot-cache.md mtime is older than 24h, DO NOT
 * present it as a fresh snapshot. Re-frame it as an ELAVULT (stale) historical
 * reference and tell the agent to re-establish state from the ledger / kanban.
 *
 * These tests drive the REAL python hook end-to-end via stdin/stdout, using an
 * isolated throwaway agent dir under the worktree install root (never touches a
 * live agent's hot-cache), with mtime controlled via fs.utimesSync.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// PROJECT_ROOT = two dirs up from src/__tests__ ; this is also the hook's _install_dir().
const INSTALL_DIR = join(__dirname, '../..')
const HOOK = join(INSTALL_DIR, 'scripts/hooks/hot-cache-sessionstart.py')

const TEST_AGENT = 'zz-test-hotcache-staleness'
const TEST_AGENT_DIR = join(INSTALL_DIR, 'agents', TEST_AGENT)
const CACHE_DIR = join(TEST_AGENT_DIR, '.claude')
const CACHE_FILE = join(CACHE_DIR, 'hot-cache.md')

const SAMPLE = '# Test Agent — Hot Cache\n\n**Last task:** wiring the foo widget\n**Pending:** bar, baz'
const FRESH_PHRASE = 'naprakészen tartott pillanatkép' // present only in the fresh HEADER

// Run the hook with a payload, return parsed additionalContext (or null when the
// hook no-ops with empty stdout).
function runHook(source: string): string | null {
  const out = execFileSync('python3', [HOOK], {
    input: JSON.stringify({ source, cwd: TEST_AGENT_DIR }),
    encoding: 'utf-8',
    // Phase 1 tests the staleness-guard on a controlled backdated file. Phase 2b
    // (card 6485f301) would regenerate that file fresh and defeat the guard by
    // design, so disable the SessionStart refresh here to test the guard in
    // isolation. The refresh path has its own coverage in
    // hot-cache-sessionstart-refresh.test.ts.
    env: { ...process.env, HOT_CACHE_SESSIONSTART_REFRESH: '0' },
  })
  const trimmed = out.trim()
  if (!trimmed) return null
  const parsed = JSON.parse(trimmed)
  return parsed?.hookSpecificOutput?.additionalContext ?? null
}

function writeCache(content: string, ageSeconds: number): void {
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(CACHE_FILE, content, 'utf-8')
  const when = Math.floor(Date.now() / 1000) - ageSeconds
  utimesSync(CACHE_FILE, when, when)
}

afterEach(() => {
  rmSync(TEST_AGENT_DIR, { recursive: true, force: true })
})

describe('hot-cache-sessionstart.py staleness-guard (card fedb4b5f)', () => {
  const H = 3600

  it('FRESH (<24h): injects the cache as a current snapshot, no stale warning', () => {
    writeCache(SAMPLE, 1 * H) // 1 hour old
    const block = runHook('resume')
    expect(block).toBeTruthy()
    expect(block).toContain('wiring the foo widget')
    expect(block).toContain(FRESH_PHRASE)
    expect(block).not.toMatch(/ELAVULT|elavult/)
  })

  it('boundary just under 24h is still fresh', () => {
    writeCache(SAMPLE, 23 * H)
    const block = runHook('resume')
    expect(block).toContain(FRESH_PHRASE)
    expect(block).not.toMatch(/ELAVULT/)
  })

  it('STALE (>24h): re-frames as ELAVULT historical reference, not a fresh snapshot', () => {
    writeCache(SAMPLE, 25 * H)
    const block = runHook('resume')
    expect(block).toBeTruthy()
    // The warning is present and the fresh framing is gone.
    expect(block).toMatch(/ELAVULT/)
    expect(block).not.toContain(FRESH_PHRASE)
    // It still carries the content (as historical), and points at the live sources.
    expect(block).toContain('wiring the foo widget')
    expect(block).toMatch(/ledger|kanban/i)
  })

  it('STALE: reports the age in days (8-day-old freeze repro)', () => {
    writeCache(SAMPLE, 8 * 24 * H)
    const block = runHook('resume')
    expect(block).toMatch(/ELAVULT/)
    expect(block).toMatch(/8\s*nap/)
  })

  it('MISSING file: no-ops (empty output), unchanged behaviour', () => {
    // No cache file written.
    const block = runHook('resume')
    expect(block).toBeNull()
  })

  it('startup + stateless test agent: still skips (mode gate unchanged)', () => {
    writeCache(SAMPLE, 25 * H)
    // zz-test-hotcache-staleness is not in MINI_HOT_CACHE_AGENTS, startup -> skip.
    const block = runHook('startup')
    expect(block).toBeNull()
  })
})

// A SessionStart hook MUST NEVER crash: a non-zero exit or a thrown traceback on
// bad input would break agent startup fleet-wide. The staleness-guard added a
// stat() call -- prove the hook still degrades to a clean no-op on every
// malformed/edge input instead of raising. (This is the deterministic substitute
// for a c12-buster smoke, which cannot exercise this hook: buster's SessionStart
// chain does not include it -- only the main agent wires it.)
describe('hot-cache-sessionstart.py robustness (never breaks SessionStart)', () => {
  function exitCode(stdin: string): number {
    try {
      // Disable the Phase 2b refresh: an empty/`{}` payload resolves to the main
      // agent on the startup path, which would otherwise trigger a real cache
      // write. These tests only assert the hook never crashes on bad input.
      execFileSync('python3', [HOOK], {
        input: stdin,
        encoding: 'utf-8',
        env: { ...process.env, HOT_CACHE_SESSIONSTART_REFRESH: '0' },
      })
      return 0
    } catch (err: any) {
      return err.status ?? 1
    }
  }

  it('empty stdin -> exit 0, no crash', () => {
    expect(exitCode('')).toBe(0)
  })

  it('malformed JSON stdin -> exit 0, no crash', () => {
    expect(exitCode('{not json')).toBe(0)
  })

  it('JSON without cwd/source -> exit 0, no crash', () => {
    expect(exitCode('{}')).toBe(0)
  })

  it('null source -> exit 0, no crash', () => {
    expect(exitCode(JSON.stringify({ source: null, cwd: null }))).toBe(0)
  })
})
