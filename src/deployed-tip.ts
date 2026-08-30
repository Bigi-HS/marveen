import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger.js'

/**
 * Copies dist/.built-from -> store/.deployed-tip so that deploy-delta-check.py
 * always has an accurate base for the next pre-deploy risk scan, without relying
 * on the Armorer manually running update-deployed-tip.sh after fleet-deploy-verify.
 *
 * Called once per server start (after acquireLock). Non-fatal: a missing or empty
 * stamp is logged and skipped so a stale marker never blocks startup.
 */
export function syncDeployedTip(projectRoot: string): void {
  const builtFrom = join(projectRoot, 'dist', '.built-from')
  const deployedTip = join(projectRoot, 'store', '.deployed-tip')
  try {
    const sha = readFileSync(builtFrom, 'utf8').trim()
    if (!sha) {
      logger.warn('syncDeployedTip: dist/.built-from is empty, skipping')
      return
    }
    writeFileSync(deployedTip, sha + '\n', 'utf8')
    logger.info({ sha: sha.slice(0, 8) }, 'deployed-tip synced from dist/.built-from')
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      logger.warn('syncDeployedTip: dist/.built-from not found, skipping')
    } else {
      logger.warn({ err }, 'syncDeployedTip: unexpected error, skipping')
    }
  }
}
