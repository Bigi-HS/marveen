// Real Inv-10 Boss-alert (card 2efcb439, v2-spec-p9-sandbox-release.md §7/§12,
// slice 4c-2). Fills the `alert` seam deployRelease injects. deployRelease calls
// it only on an auto-rollback -- the explicit exception to quiet-mode -- so an
// unattended fix-window deploy that reverts itself never does so silently.
//
// It binds the shared operator-alert delivery seam (operator-alert.ts, which
// targets the Boss chat) to a stable deploy tag, and is FAIL-SAFE: deployRelease
// wraps the alert in a best-effort call and discards the outcome, so a dead
// Telegram path here would otherwise vanish. This module swallows the delivery
// error and logs a durable trace instead, so the rollback is still recoverable
// from dashboard.log even when the notification cannot be sent.

import { logger } from '../logger.js'
import { defaultDeliver, type AlertDeliver } from './operator-alert.js'
import type { DeployAlert } from './release-pipeline.js'

// Stable, grep-able prefix so deploy/rollback alerts can be filtered from other
// operator notifications.
export const DEPLOY_ALERT_TAG = '[P9-DEPLOY]'

// Build the Inv-10 alert bound to a delivery seam (defaults to the real Boss
// Telegram send). The returned thunk never rejects.
export function makeDeployAlert(deliver: AlertDeliver = defaultDeliver): DeployAlert {
  return async (message: string): Promise<void> => {
    const text = `${DEPLOY_ALERT_TAG} ${message}`
    try {
      await deliver(text)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      logger.error({ text, err: detail }, 'P9 deploy alert delivery failed')
    }
  }
}
