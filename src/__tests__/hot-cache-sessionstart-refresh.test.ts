/**
 * Tests for the refresh-before-inject behaviour of the SessionStart hook
 * scripts/hooks/hot-cache-sessionstart.py (card 6485f301, Continuity Phase 2b).
 *
 * Phase 2 (card fedb4b5f) regenerates each agent's hot-cache.md on the 4h
 * fleet-supervisor tick, so a snapshot injected at SessionStart can be up to 4h
 * old on a fresh session / resume. Phase 2b closes that window: the hook itself
 * regenerates THIS agent's snapshot from live sources (in_progress kanban cards +
 * last ledger turn) immediately before it injects, with the 4h throttle bypassed
 * for that one agent only. So a new/resumed session always reflects the
 * immediate-last state, not a stale tick result -- and the staleness-guard stays a
 * backstop rather than the normal path.
 *
 * These drive the REAL hook end-to-end against throwaway temp DBs and a temp
 * install root (HOT_CACHE_INSTALL_DIR), asserting: regeneration replaces a stale
 * file, the toggle (HOT_CACHE_SESSIONSTART_REFRESH) preserves the legacy path,
 * refresh is scoped to inject-paths and to the agent's own cache, and a broken DB
 * degrades cleanly without breaking injection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INSTALL_DIR = join(__dirname, '../..')
const HOOK = join(INSTALL_DIR, 'scripts/hooks/hot-cache-sessionstart.py')

const ROOT = join('/tmp', 'test-hotcache-sessionstart-refresh')
const FAKE_INSTALL = join(ROOT, 'install')
const NOA_DB = join(ROOT, 'noa.db')
const LEDGER_DB = join(ROOT, 'ledger.db')

function seedKanban(
  rows: Array<{ id: string; title: string; assignee: string; status: string; priority: string; score: number }>,
): void {
  const db = new Database(NOA_DB)
  db.exec(
    `CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, title TEXT, description TEXT,
      status TEXT, assignee TEXT, priority TEXT, priority_score INTEGER)`,
  )
  const ins = db.prepare(
    'INSERT INTO kanban_cards (id,title,status,assignee,priority,priority_score) VALUES (?,?,?,?,?,?)',
  )
  for (const r of rows) ins.run(r.id, r.title, r.status, r.assignee, r.priority, r.score)
  db.close()
}

function seedLedger(rows: Array<{ agent: string; direction: 'in' | 'out'; text: string; ts: string; created_at: number }>): void {
  const db = new Database(LEDGER_DB)
  db.exec(
    `CREATE TABLE conversation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
      chat_id TEXT NOT NULL, direction TEXT NOT NULL, message_id TEXT, text TEXT, ts TEXT,
      created_at INTEGER NOT NULL)`,
  )
  const ins = db.prepare(
    'INSERT INTO conversation_log (agent_id,chat_id,direction,message_id,text,ts,created_at) VALUES (?,?,?,?,?,?,?)',
  )
  let mid = 0
  for (const r of rows) ins.run(r.agent, '123', r.direction, String(++mid), r.text, r.ts, r.created_at)
  db.close()
}

function cachePath(agent: string): string {
  return join(FAKE_INSTALL, 'agents', agent, '.claude', 'hot-cache.md')
}

// Pre-write a hot-cache.md and back-date its mtime so the staleness-guard (24h)
// would fire on it if the hook read it without refreshing first.
function preWriteStale(agent: string, content: string, ageHours = 48): void {
  const p = cachePath(agent)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content, 'utf-8')
  const t = Math.floor(Date.now() / 1000) - ageHours * 3600
  utimesSync(p, t, t)
}

function runHook(source: string, agentId: string, extraEnv: Record<string, string> = {}): Record<string, any> {
  const cwd = join(FAKE_INSTALL, 'agents', agentId)
  const payload = JSON.stringify({ cwd, source })
  const out = execFileSync('python3', [HOOK], {
    input: payload,
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOT_CACHE_INSTALL_DIR: FAKE_INSTALL,
      NOA_DB_PATH: NOA_DB,
      LEDGER_DB_PATH: LEDGER_DB,
      MAIN_AGENT_ID: 'marveen',
      ...extraEnv,
    },
  })
  return out.trim() ? JSON.parse(out) : {}
}

function ctxOf(res: Record<string, any>): string {
  return res?.hookSpecificOutput?.additionalContext ?? ''
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(FAKE_INSTALL, { recursive: true })
})
afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('hot-cache-sessionstart.py refresh-before-inject (card 6485f301)', () => {
  it('regenerates the snapshot from live sources before injecting (resume)', () => {
    seedKanban([{ id: 'w1a2b3', title: 'wire the widget', assignee: 'dave', status: 'in_progress', priority: 'high', score: 3 }])
    seedLedger([{ agent: 'dave', direction: 'in', text: 'do the widget task now', ts: '2026-07-01T20:00', created_at: 1000 }])
    // A stale file that MUST be overwritten by the fresh regeneration.
    preWriteStale('dave', 'STALE OLD CONTENT that must be replaced', 72)

    const ctx = ctxOf(runHook('resume', 'dave'))

    expect(ctx).toContain('w1a2b3')
    expect(ctx).toContain('wire the widget')
    expect(ctx).toContain('do the widget task now')
    expect(ctx).not.toContain('STALE OLD CONTENT')
    // Refresh made the cache fresh -> the staleness header must NOT appear.
    expect(ctx).not.toContain('ELAVULT')
  })

  it('toggle OFF preserves the legacy path: a stale file still triggers the staleness header', () => {
    // Contrast to the test above: with refresh disabled the hook reads the
    // pre-existing (backdated) file verbatim and the 24h staleness-guard fires.
    preWriteStale('dave', 'ANCIENT snapshot body', 72)

    const ctx = ctxOf(runHook('resume', 'dave', { HOT_CACHE_SESSIONSTART_REFRESH: '0' }))

    expect(ctx).toContain('ANCIENT snapshot body')
    expect(ctx).toContain('ELAVULT')
  })

  it('regenerates on the startup mini-inject path for a context-sensitive agent', () => {
    seedKanban([{ id: 'mini99', title: 'startup regenerated card', assignee: 'dave', status: 'in_progress', priority: 'normal', score: 5 }])
    seedLedger([])

    const ctx = ctxOf(runHook('startup', 'dave'))

    expect(ctx.length).toBeGreaterThan(0)
    expect(ctx).toContain('mini99')
    expect(ctx).toContain('startup regenerated card')
  })

  it('does NOT refresh (or inject) for a stateless agent on startup', () => {
    // thor is stateless: startup exits before the refresh step, so no cache is
    // written and nothing is injected. Proves refresh is scoped to inject-paths.
    seedKanban([{ id: 'th0001', title: 'thor card', assignee: 'thor', status: 'in_progress', priority: 'normal', score: 5 }])
    seedLedger([])

    const res = runHook('startup', 'thor')

    expect(res).toEqual({})
    expect(existsSync(cachePath('thor'))).toBe(false)
  })

  it('per-agent scope: refreshing dave never writes another agent\'s cache', () => {
    seedKanban([
      { id: 'dav001', title: 'dave card', assignee: 'dave', status: 'in_progress', priority: 'normal', score: 5 },
      { id: 'tho001', title: 'thor secret card', assignee: 'thor', status: 'in_progress', priority: 'normal', score: 5 },
    ])
    seedLedger([{ agent: 'thor', direction: 'in', text: 'thor private message', ts: 't', created_at: 20 }])

    const ctx = ctxOf(runHook('resume', 'dave'))

    expect(ctx).toContain('dav001')
    expect(ctx).not.toContain('tho001')
    expect(ctx).not.toContain('thor secret card')
    expect(ctx).not.toContain('thor private message')
    // dave's refresh must not have created thor's cache file.
    expect(existsSync(cachePath('thor'))).toBe(false)
  })

  it('fail-open: a broken NOA_DB degrades to an empty card list without breaking injection', () => {
    seedLedger([{ agent: 'dave', direction: 'in', text: 'hello there dave', ts: 't', created_at: 1 }])

    const ctx = ctxOf(runHook('resume', 'dave', { NOA_DB_PATH: join(ROOT, 'does-not-exist', 'noa.db') }))

    expect(ctx).toContain('Nincs aktív kártya')
    expect(ctx).toContain('hello there dave')
  })

  it('no cards and no ledger still injects a fresh minimal snapshot on resume', () => {
    seedKanban([])
    seedLedger([])

    const ctx = ctxOf(runHook('resume', 'dave'))

    expect(ctx).toContain('# dave')
    expect(ctx).toContain('Nincs aktív kártya')
  })
})
