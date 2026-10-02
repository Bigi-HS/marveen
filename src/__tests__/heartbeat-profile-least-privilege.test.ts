/**
 * SEC-099 (card 213fd3bf): the heartbeat securityProfile is narrowed from the
 * interim "default" to a least-privilege "heartbeat" profile. These tests pin the
 * Chad-approved allow/deny spec (sec-GO 2026-10-01, msg 18109/18121) so a later
 * edit cannot silently re-widen the background agent's permission floor.
 *
 * Spec (allow):
 *   Bash(python3 .../scripts/noa-api.py:*)   -- dashboard API GET/POST, token
 *                                               stays INSIDE the script
 *   mcp__server-google-calendar-mcp__list-events
 *   Bash(stat:*) / Bash(ls:*)                -- DB-size checks
 *   Read(${AGENT_DIR}/**) / Write(${AGENT_DIR}/**)  -- OWN dir only (Chad condition)
 * NOT allowed: Telegram MCP send, raw curl+token, sqlite3, other agents' store/.
 */
import { describe, it, expect } from 'vitest'
import { loadProfileTemplate } from '../web/profiles.js'

const P = loadProfileTemplate('heartbeat')
const allow = P.filesystem.allow
const deny = P.filesystem.deny

describe('heartbeat least-privilege profile (SEC-099)', () => {
  it('is strict so Claude Code enforces the list (channel-less => skip flag dropped)', () => {
    expect(P.id).toBe('heartbeat')
    expect(P.permissionMode).toBe('strict')
  })

  it('allows exactly the Chad-approved capability set', () => {
    expect(allow).toContain('Bash(python3 /home/domin/marveen/scripts/noa-api.py:*)')
    expect(allow).toContain('mcp__server-google-calendar-mcp__list-events')
    expect(allow).toContain('Bash(stat:*)')
    expect(allow).toContain('Bash(ls:*)')
    expect(allow).toContain('Read(${AGENT_DIR}/**)')
    expect(allow).toContain('Write(${AGENT_DIR}/**)')
  })

  it('scopes Read/Write to the OWN dir only -- never a broad fs grant (Chad condition)', () => {
    // Every Read/Write/Edit allow must be rooted at ${AGENT_DIR}. A bare
    // Read(**)/Write(**)/Read(/**) would blow the own-dir constraint.
    const fsAllows = allow.filter((a) => /^(Read|Write|Edit)\(/.test(a))
    for (const a of fsAllows) {
      expect(a.includes('${AGENT_DIR}/')).toBe(true)
    }
  })

  it('does NOT grant the explicitly-forbidden capabilities', () => {
    const joined = allow.join('\n')
    // no Telegram MCP (send is an external irreversible effect)
    expect(joined).not.toMatch(/telegram/i)
    // no raw curl in the allow set (the dashboard API goes through noa-api.py)
    expect(joined).not.toMatch(/Bash\(curl/)
    // no sqlite3 (DB is read via the API, not the raw file)
    expect(joined).not.toMatch(/sqlite3/)
    // no blanket web access
    expect(joined).not.toMatch(/WebFetch|WebSearch/)
  })

  it('denies the sensitive classes as defense-in-depth (secrets, sqlite3, raw POST, config writes)', () => {
    expect(deny).toContain('Bash(sqlite3:*)')
    expect(deny).toContain('Bash(curl -X POST:*)')
    expect(deny).toContain('Read(**/.dashboard-token)')
    expect(deny).toContain('Read(**/.git-credentials)')
    expect(deny).toContain('Write(**/settings.json)')
    expect(deny).toContain('Write(**/.mcp.json)')
    expect(deny).toContain('Bash(pkill:*)')
  })

  it('no deny rule shadows an allowed capability (stat/ls/noa-api.py/calendar/own-dir)', () => {
    // The defense-in-depth deny list must not accidentally block the 6 allows.
    // None of the deny patterns target stat/ls/noa-api.py/list-events, and the
    // only Read/Write denies are sensitive-file globs, not ${AGENT_DIR} itself.
    expect(deny).not.toContain('Bash(stat:*)')
    expect(deny).not.toContain('Bash(ls:*)')
    expect(deny.some((d) => d.includes('noa-api.py'))).toBe(false)
    expect(deny).not.toContain('Read(${AGENT_DIR}/**)')
    expect(deny).not.toContain('Write(${AGENT_DIR}/**)')
  })
})
