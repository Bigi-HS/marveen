import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The installed app's webview connects to the backend over the Tailscale
// MagicDNS origin (https, publicly-trusted cert). The release CSP connect-src
// must allow it or every API/pairing call fails silently in the release build.
const TAILNET_ORIGIN = 'https://bigi.tail1a5fa5.ts.net'

// vitest runs with cwd at the dashboard-new root (vite config root).
function readCsp(): string {
  const raw = readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf-8')
  const conf = JSON.parse(raw) as { app: { security: { csp: string } } }
  return conf.app.security.csp
}

function connectSrc(): string {
  const dir = readCsp()
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('connect-src'))
  if (!dir) throw new Error('no connect-src directive in CSP')
  return dir
}

describe('tauri CSP connect-src', () => {
  it('allows the Tailscale backend origin', () => {
    expect(connectSrc()).toContain(TAILNET_ORIGIN)
  })

  it('still allows localhost for local dev/proxy', () => {
    expect(connectSrc()).toContain('http://localhost:3420')
  })

  it("keeps 'self'", () => {
    expect(connectSrc()).toContain("'self'")
  })
})
