import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isWithinServerBootGrace, SERVER_BOOT_GRACE_MS } from '../web/channel-monitor.js'

// Card 3d70de24 (umbrella d93b3b60). The dashboard server was observed CRASH-LOOPING
// on 2026-09-04 16:27 (full reboot every 1-2 min). On every fresh boot the main
// channels session's plugin read is transiently unreliable, and an automatic fresh
// respawn KILLS a healthy Telegram pipe -- the "session respawned fresh" log fired
// on every boot and muted Genesis. The server-boot grace defers the AUTOMATIC
// respawn until the server has been up past the window; process.uptime() resets on
// each crash-loop boot so a short-lived boot can never churn the pipe. Manual
// operator restarts bypass it.
describe('server-boot grace (card 3d70de24)', () => {
  describe('isWithinServerBootGrace (pure decision)', () => {
    it('is TRUE from boot through the grace window (defer automatic respawn)', () => {
      expect(isWithinServerBootGrace(0)).toBe(true)
      expect(isWithinServerBootGrace(1)).toBe(true)
      expect(isWithinServerBootGrace(SERVER_BOOT_GRACE_MS - 1)).toBe(true)
    })
    it('is FALSE once the server is up past the window (resume normal recovery)', () => {
      expect(isWithinServerBootGrace(SERVER_BOOT_GRACE_MS)).toBe(false)
      expect(isWithinServerBootGrace(SERVER_BOOT_GRACE_MS + 1)).toBe(false)
      expect(isWithinServerBootGrace(60 * 60 * 1000)).toBe(false)
    })
    it('is FALSE for a negative/garbage uptime (fail toward recovery, never lock it off)', () => {
      expect(isWithinServerBootGrace(-1)).toBe(false)
      expect(isWithinServerBootGrace(-999_999)).toBe(false)
    })
    it('honours a custom grace window', () => {
      expect(isWithinServerBootGrace(50, 100)).toBe(true)
      expect(isWithinServerBootGrace(100, 100)).toBe(false)
      expect(isWithinServerBootGrace(150, 100)).toBe(false)
    })
    it('uses a grace within the Forge-specified 90-120s range', () => {
      expect(SERVER_BOOT_GRACE_MS).toBeGreaterThanOrEqual(90_000)
      expect(SERVER_BOOT_GRACE_MS).toBeLessThanOrEqual(120_000)
    })
  })

  describe('wiring contract (locks the guard against silent regressions)', () => {
    const monitorSrc = readFileSync(new URL('../web/channel-monitor.ts', import.meta.url), 'utf-8')

    it('the fresh-respawn choke point + hard-restart take a bypassable opts param', () => {
      expect(monitorSrc).toMatch(/function respawnMarveenSessionFresh\(\s*opts/)
      expect(monitorSrc).toMatch(/export function hardRestartMarveenChannels\(\s*opts/)
    })
    it('the guard keys off the LIVE server process uptime (not a session stamp)', () => {
      expect(monitorSrc).toMatch(/isWithinServerBootGrace\(\s*process\.uptime\(\)\s*\*\s*1000/)
    })
    it('all three manual operator restart routes bypass the boot grace (never deferred)', () => {
      const marveenRoute = readFileSync(new URL('../web/routes/marveen.ts', import.meta.url), 'utf-8')
      const agentsRoute = readFileSync(new URL('../web/routes/agents.ts', import.meta.url), 'utf-8')
      const pat = /hardRestartMarveenChannels\(\{\s*bypassBootGrace:\s*true\s*\}\)/g
      expect((marveenRoute.match(pat) || []).length).toBe(1)
      expect((agentsRoute.match(pat) || []).length).toBe(2)
    })
  })
})
