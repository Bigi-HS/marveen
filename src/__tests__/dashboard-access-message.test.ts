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
})
