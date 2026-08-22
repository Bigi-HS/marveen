/**
 * Tests for scripts/hot-cache-refresh.py (card fedb4b5f Phase 2).
 *
 * The refresher regenerates each agent's .claude/hot-cache.md from deterministic
 * sources so the SessionStart snapshot can't freeze: in_progress kanban cards
 * (noa.db) + the agent's most recent ledger turn (conversation_log). These tests
 * drive the REAL script end-to-end against throwaway temp DBs and a temp install
 * root, asserting the rendered snapshot, the per-agent isolation, and the mtime
 * self-throttle (so the fleet-supervisor can call it every tick safely).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const INSTALL_DIR = join(__dirname, '../..')
const SCRIPT = join(INSTALL_DIR, 'scripts/hot-cache-refresh.py')

const ROOT = join('/tmp', 'test-hotcache-refresh')
const FAKE_INSTALL = join(ROOT, 'install')
const NOA_DB = join(ROOT, 'noa.db')
const LEDGER_DB = join(ROOT, 'ledger.db')

function seedKanban(rows: Array<{ id: string; title: string; assignee: string; status: string; priority: string; score: number }>): void {
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

function run(args: string[], extraEnv: Record<string, string> = {}): Record<string, string> {
  const out = execFileSync('python3', [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      HOT_CACHE_INSTALL_DIR: FAKE_INSTALL,
      NOA_DB_PATH: NOA_DB,
      LEDGER_DB_PATH: LEDGER_DB,
      MAIN_AGENT_ID: 'marveen',
      HOT_CACHE_REFRESH_SECONDS: '14400',
      ...extraEnv,
    },
  })
  return JSON.parse(out.trim())
}

function cachePath(agent: string): string {
  return agent === 'marveen'
    ? join(FAKE_INSTALL, '.claude', 'hot-cache.md')
    : join(FAKE_INSTALL, 'agents', agent, '.claude', 'hot-cache.md')
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(FAKE_INSTALL, { recursive: true })
})
afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('hot-cache-refresh.py (card fedb4b5f Phase 2)', () => {
  it('writes a snapshot from in_progress cards + last inbound', () => {
    seedKanban([
      { id: 'aaa111', title: 'wire the foo widget', assignee: 'dave', status: 'in_progress', priority: 'high', score: 3 },
      { id: 'bbb222', title: 'done thing', assignee: 'dave', status: 'done', priority: 'low', score: 9 },
    ])
    seedLedger([
      { agent: 'dave', direction: 'in', text: 'csinald meg a foo widgetet', ts: '2026-06-30T10:00', created_at: 1000 },
      { agent: 'dave', direction: 'out', text: 'rendben', ts: '2026-06-30T10:01', created_at: 1001 },
    ])
    const res = run(['dave'])
    expect(res.dave).toBe('refresh')
    const body = readFileSync(cachePath('dave'), 'utf-8')
    expect(body).toContain('# dave — Hot Cache')
    expect(body).toContain('auto')
    expect(body).toContain('aaa111')
    expect(body).toContain('wire the foo widget')
    expect(body).not.toContain('bbb222') // done card excluded
    expect(body).toContain('csinald meg a foo widgetet')
  })

  it('renders "Nincs aktív kártya" when the agent has no in_progress cards', () => {
    seedKanban([])
    seedLedger([])
    run(['dave'])
    expect(readFileSync(cachePath('dave'), 'utf-8')).toContain('Nincs aktív kártya')
  })

  it('isolates per-agent: dave cache never shows another agent\'s card or ledger', () => {
    seedKanban([
      { id: 'dav001', title: 'dave card', assignee: 'dave', status: 'in_progress', priority: 'normal', score: 5 },
      { id: 'tho001', title: 'thor secret card', assignee: 'thor', status: 'in_progress', priority: 'normal', score: 5 },
    ])
    seedLedger([
      { agent: 'dave', direction: 'in', text: 'dave message', ts: 't', created_at: 10 },
      { agent: 'thor', direction: 'in', text: 'thor private message', ts: 't', created_at: 20 },
    ])
    run(['dave'])
    const body = readFileSync(cachePath('dave'), 'utf-8')
    expect(body).toContain('dav001')
    expect(body).not.toContain('tho001')
    expect(body).not.toContain('thor secret card')
    expect(body).not.toContain('thor private message')
  })

  it('marveen writes to <install>/.claude, sub-agents to agents/<id>/.claude', () => {
    seedKanban([{ id: 'mar001', title: 'main task', assignee: 'marveen', status: 'in_progress', priority: 'high', score: 2 }])
    seedLedger([])
    run(['marveen'])
    expect(existsSync(join(FAKE_INSTALL, '.claude', 'hot-cache.md'))).toBe(true)
    expect(existsSync(join(FAKE_INSTALL, 'agents', 'marveen', '.claude', 'hot-cache.md'))).toBe(false)
  })

  it('self-throttles: a fresh cache is skipped, --force overrides', () => {
    seedKanban([{ id: 'c1', title: 't', assignee: 'dave', status: 'in_progress', priority: 'low', score: 8 }])
    seedLedger([])
    expect(run(['dave']).dave).toBe('refresh')
    // Second run immediately after: cache is fresh -> skip.
    expect(run(['dave']).dave).toBe('skip')
    // --force regenerates regardless of mtime.
    expect(run(['--force', 'dave']).dave).toBe('refresh')
  })

  it('refreshes a cache older than the throttle interval', () => {
    seedKanban([{ id: 'c1', title: 't', assignee: 'dave', status: 'in_progress', priority: 'low', score: 8 }])
    seedLedger([])
    run(['dave'])
    // Back-date the cache to 5h ago (> 4h interval) -> next run refreshes.
    const p = cachePath('dave')
    const old = Math.floor(Date.now() / 1000) - 5 * 3600
    utimesSync(p, old, old)
    expect(run(['dave']).dave).toBe('refresh')
  })

  it('degrades cleanly when noa.db is missing (no crash, empty card list)', () => {
    // No seedKanban -> NOA_DB file absent.
    seedLedger([{ agent: 'dave', direction: 'in', text: 'hi', ts: 't', created_at: 1 }])
    const res = run(['dave'])
    expect(res.dave).toBe('refresh')
    const body = readFileSync(cachePath('dave'), 'utf-8')
    expect(body).toContain('Nincs aktív kártya')
    expect(body).toContain('hi')
  })

  it('truncates an over-long inbound snippet', () => {
    seedKanban([])
    const longText = 'x'.repeat(500)
    seedLedger([{ agent: 'dave', direction: 'in', text: longText, ts: 't', created_at: 1 }])
    run(['dave'])
    const body = readFileSync(cachePath('dave'), 'utf-8')
    expect(body).toContain('…')
    expect(body.length).toBeLessThan(1900) // under the hook's 2000 cap
  })

  it('default (no agent arg) refreshes the channel-agent roster', () => {
    seedKanban([])
    seedLedger([])
    const res = run([])
    for (const a of ['marveen', 'claudia', 'hibiki', 'bond', 'bigben', 'scout', 'dave']) {
      expect(res[a]).toBe('refresh')
    }
  })
})

// Static-assertion coverage that the always-on fleet-supervisor actually wires the
// refresher into its tick loop (WSL has no cron). Mirrors the ensure_hibiki_push
// precedent: throttled spawn, DRY_RUN guard, own log, non-fatal on failure.
describe('fleet-supervisor.sh wires hot-cache-refresh (card fedb4b5f Phase 2)', () => {
  const SRC = readFileSync(join(INSTALL_DIR, 'scripts/fleet-supervisor.sh'), 'utf-8')

  it('defines and calls ensure_hot_cache_refresh from tick()', () => {
    expect(SRC).toMatch(/ensure_hot_cache_refresh\(\)\s*\{/)
    // called in the tick body (a second, bare occurrence).
    expect(SRC.match(/ensure_hot_cache_refresh/g)!.length).toBeGreaterThanOrEqual(2)
  })

  it('spawns the refresher script with a throttle + DRY_RUN guard + own log', () => {
    expect(SRC).toMatch(/HOT_CACHE_REFRESH_THROTTLE_SECONDS/)
    expect(SRC).toMatch(/python3 "\$refresh"/)
    expect(SRC).toMatch(/scripts\/hot-cache-refresh\.py/)
    expect(SRC).toMatch(/DRY-RUN would: hot-cache-refresh\.py/)
    expect(SRC).toMatch(/hot-cache-refresh\.log/)
  })

  it('throttle window is bounded (idempotent, safe to call every tick)', () => {
    expect(SRC).toMatch(/hot_cache_refresh_due\(\)/)
    expect(SRC).toMatch(/hot-cache-refresh\.next/)
  })
})
