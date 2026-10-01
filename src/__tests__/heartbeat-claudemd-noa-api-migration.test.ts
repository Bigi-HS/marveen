/**
 * SEC-099 PR1 (card 213fd3bf, B-split make-compliant step): the heartbeat agent's
 * operational CLAUDE.md is migrated OFF the raw `sqlite3 store/noa.db` reads and the
 * raw `curl -X POST` + token-file send ONTO the guard-safe `noa-api.py` helper
 * (token stays INSIDE the script). This is behavior-preserving -- same four data
 * sources, same output format, same inter-agent hand-off to Marveen -- but it uses
 * only the capabilities the least-privilege `heartbeat` profile (PR2) will allow.
 *
 * Why PR1 first: narrowing the profile BEFORE this migration would break the live
 * heartbeat (the strict profile denies sqlite3 + raw curl). make-compliant -> then
 * tighten (lesson-failclosed-change-deploy-ordering). PR1 must NOT touch the profile
 * (still 'default' here); PR2 flips it to 'heartbeat' after this deploys + verifies.
 */
import { describe, it, expect } from 'vitest'
import { renderClaudeMd, renderAgentConfigJson } from '../web/heartbeat-agent-scaffold.js'

const md = renderClaudeMd()
const NOA = 'python3 /home/domin/marveen/scripts/noa-api.py'

describe('heartbeat CLAUDE.md -- noa-api.py migration (SEC-099 PR1)', () => {
  it('no longer instructs raw sqlite3 reads', () => {
    expect(md).not.toMatch(/sqlite3/)
  })

  it('no longer instructs a raw curl POST or a token-file read', () => {
    expect(md).not.toMatch(/curl\s+-s\s+-X\s+POST/)
    expect(md).not.toMatch(/curl\b.*api\/messages/)
    // the token must never be read into a shell var in the prose
    expect(md).not.toMatch(/TOKEN=\$\(</)
    expect(md).not.toMatch(/\.dashboard-token/)
    expect(md).not.toMatch(/Authorization:\s*Bearer/)
  })

  it('reads kanban via noa-api.py GET /api/kanban', () => {
    expect(md).toContain(`${NOA} GET /api/kanban`)
  })

  it('reads scheduled tasks via noa-api.py GET /api/schedules', () => {
    expect(md).toContain(`${NOA} GET /api/schedules`)
  })

  it('reads memories via noa-api.py GET /api/memories', () => {
    expect(md).toContain(`${NOA} GET`)
    expect(md).toMatch(/noa-api\.py GET \/api\/memories/)
  })

  it('sends the report via noa-api.py POST /api/messages (token stays in the script)', () => {
    expect(md).toContain(`${NOA} POST /api/messages`)
  })

  it('uses the absolute noa-api.py path so the PR2 heartbeat profile allow-rule matches', () => {
    // profile allow: Bash(python3 /home/domin/marveen/scripts/noa-api.py:*)
    // a bare relative `scripts/noa-api.py` would NOT match that prefix -> denied.
    const calls = md.match(/noa-api\.py/g) || []
    expect(calls.length).toBeGreaterThanOrEqual(4) // kanban, schedules, memories, messages
    expect(md).not.toMatch(/[^/]scripts\/noa-api\.py/) // no bare relative form
  })

  it('is behavior-preserving: same four data sources + output format + Marveen hand-off', () => {
    // data sources
    expect(md).toMatch(/Calendar/)
    expect(md).toContain('mcp__server-google-calendar-mcp__list-events')
    expect(md).toMatch(/Kanban/)
    expect(md).toMatch(/Tasks/)
    expect(md).toMatch(/Memory/)
    // DB size still via stat/ls (allowed), not sqlite3
    expect(md).toMatch(/DB (file )?size|DB size/i)
    // hand-off contract unchanged
    expect(md).toMatch(/inter-agent message/i)
    expect(md).toMatch(/\bMarveen\b/)
  })

  it('still forbids any direct Telegram / human contact (hard rule intact)', () => {
    expect(md).toMatch(/NEVER.*reply.*Telegram|NEVER.*Telegram/i)
  })

  it('does NOT change the securityProfile in PR1 (still the interim default)', () => {
    // PR1 is the migration only; PR2 narrows the profile. Guard against an
    // accidental atomic change that would re-introduce the fail-closed trap.
    expect(renderAgentConfigJson()).toContain('"securityProfile": "default"')
  })
})
