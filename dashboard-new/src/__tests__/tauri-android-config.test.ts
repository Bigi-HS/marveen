// Guards the Android-only Tauri config that makes the installable app reach the
// backend (card 5e95c777). The APK loads the remote funnel origin so the app's
// relative fetch('/api/...') calls land same-origin on the Tailscale-served
// backend -- no CORS, no api-client rewrite. Desktop config (tauri.conf.json)
// stays local; this override only applies to the Android build.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ANDROID_CONF = resolve(process.cwd(), 'src-tauri/tauri.android.conf.json')
const FUNNEL = 'https://bigi.tail1a5fa5.ts.net'

describe('Tauri Android remote-webview config (card 5e95c777)', () => {
  const raw = readFileSync(ANDROID_CONF, 'utf-8')
  const conf = JSON.parse(raw)

  it('points the Android main window at the remote funnel /v2/', () => {
    const windows = conf.app.windows as Array<{ label?: string; url?: string }>
    const win = windows.find((w) => w.label === 'main') ?? windows[0]
    expect(win.url).toBe(`${FUNNEL}/v2/`)
  })

  it('CSP connect-src allows the funnel origin', () => {
    const csp: string = conf.app.security.csp
    expect(csp).toContain('connect-src')
    expect(csp).toContain(FUNNEL)
  })

  it('does NOT grant remote Tauri IPC (frontend uses zero native APIs -- keep the surface closed)', () => {
    // If anyone later adds remote IPC access, this guard fails so it goes through
    // a SEC review rather than silently exposing native commands to the origin.
    expect(raw).not.toContain('dangerousRemoteDomainIpcAccess')
    expect(conf.app.security.remote).toBeUndefined()
  })
})
