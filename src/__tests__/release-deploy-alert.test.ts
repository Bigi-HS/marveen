// Tests for the real Inv-10 Boss-alert (card 2efcb439,
// v2-spec-p9-sandbox-release.md §7/§12, slice 4c-2). Fills the `alert` seam
// deployRelease injects: on an auto-rollback (the explicit quiet-mode exception)
// the Boss is notified. The alert binds the shared operator-alert delivery seam
// to a stable, grep-able deploy tag, and is FAIL-SAFE -- a dead Telegram path is
// swallowed + logged, never thrown, because deployRelease treats the alert as
// best-effort and a crash here must not mask the deploy/rollback outcome.

import { describe, it, expect, vi } from 'vitest'
import { makeDeployAlert, DEPLOY_ALERT_TAG } from '../web/release-deploy-alert.js'
import { logger } from '../logger.js'

describe('makeDeployAlert', () => {
  it('delivers the tagged message through the injected deliver', async () => {
    const sent: string[] = []
    const alert = makeDeployAlert(async (t) => {
      sent.push(t)
    })
    await alert('auto-rollback: id=7 reverted to v1.0.0')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain(DEPLOY_ALERT_TAG)
    expect(sent[0]).toContain('auto-rollback: id=7 reverted to v1.0.0')
  })

  it('prefixes the stable tag at the start (filterable)', async () => {
    const sent: string[] = []
    const alert = makeDeployAlert(async (t) => {
      sent.push(t)
    })
    await alert('hello')
    expect(sent[0].startsWith(DEPLOY_ALERT_TAG)).toBe(true)
  })

  it('is fail-safe: a throwing deliver does not reject', async () => {
    const alert = makeDeployAlert(async () => {
      throw new Error('Telegram API 503: upstream down')
    })
    await expect(alert('boom')).resolves.toBeUndefined()
  })

  it('logs a durable trace when delivery fails (swallowed, not silent)', async () => {
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    const alert = makeDeployAlert(async () => {
      throw new Error('Telegram API 401: no token')
    })
    await alert('boom')
    expect(errSpy).toHaveBeenCalledTimes(1)
    const [obj] = errSpy.mock.calls[0]
    expect(JSON.stringify(obj)).toContain('Telegram API 401')
    errSpy.mockRestore()
  })

  it('does not log on a successful delivery', async () => {
    const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    const alert = makeDeployAlert(async () => {})
    await alert('ok')
    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('returns a DeployAlert-compatible async thunk, defaulting to the real deliver', () => {
    const alert = makeDeployAlert()
    expect(typeof alert).toBe('function')
    // Not invoked here -- the default deliver would hit the real Telegram path.
  })
})
