import { describe, it, expect } from 'vitest'
import { buildDashboardAccessMessage } from '../web/dashboard-auth.js'

// item5 hygiene (token-not-in-URL): the startup access message must never embed
// the token in the URL -- a pasted/logged `/?token=<cred>` URL leaks a
// root-equivalent credential into shell history, access logs and the address bar.
describe('buildDashboardAccessMessage', () => {
  const TOKEN = 'SECRET-abc123'
  const msg = buildDashboardAccessMessage(3420, TOKEN)

  it('includes a tokenless local URL', () => {
    expect(msg).toContain('http://127.0.0.1:3420/')
  })

  it('never puts the token in a URL query string', () => {
    expect(msg).not.toContain('?token=')
    // the token must not be appended to the URL on the same line
    for (const line of msg.split('\n')) {
      if (line.includes('http://')) expect(line).not.toContain(TOKEN)
    }
  })

  it('still surfaces the token (on its own line) for the operator to paste', () => {
    expect(msg).toContain(TOKEN)
    const tokenLine = msg.split('\n').find(l => l.includes(TOKEN))
    expect(tokenLine).toBeDefined()
    expect(tokenLine).not.toContain('http')
  })

  // c2de413f remote-access: when DASHBOARD_PUBLIC_URL is set, the operator must be
  // pointed at the reachable (e.g. Tailscale Serve) URL, not a useless loopback.
  describe('DASHBOARD_PUBLIC_URL', () => {
    it('uses the public URL when provided', () => {
      const m = buildDashboardAccessMessage(3420, TOKEN, 'https://noa.tail1234.ts.net')
      expect(m).toContain('https://noa.tail1234.ts.net/')
      expect(m).not.toContain('http://127.0.0.1:3420/')
    })

    it('normalizes a trailing slash to exactly one', () => {
      const m = buildDashboardAccessMessage(3420, TOKEN, 'https://noa.tail1234.ts.net/')
      expect(m).toContain('https://noa.tail1234.ts.net/')
      expect(m).not.toContain('.ts.net//')
    })

    it('falls back to the loopback URL for an empty/whitespace public URL', () => {
      expect(buildDashboardAccessMessage(3420, TOKEN, '')).toContain('http://127.0.0.1:3420/')
      expect(buildDashboardAccessMessage(3420, TOKEN, '   ')).toContain('http://127.0.0.1:3420/')
    })

    it('keeps the token off the public URL line (no leak via the remote link)', () => {
      const m = buildDashboardAccessMessage(3420, TOKEN, 'https://noa.tail1234.ts.net')
      expect(m).not.toContain('?token=')
      for (const line of m.split('\n')) {
        if (line.includes('http')) expect(line).not.toContain(TOKEN)
      }
    })
  })
})
