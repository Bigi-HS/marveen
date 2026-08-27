import pino from 'pino'

// SRE L1a durable log sink (fleet-expansion Phase 1, card fleet-expansion-plan-0822).
// Before this, pino wrote only to stdout -> tmux scrollback, so a restart wiped the
// history (08-14: 21h of logs lost on a deploy-restart). We now fan the log out with
// pino's multi-target transport (worker-thread-safe, not a top-level `await import`):
//   - terminal: pino-pretty in dev, raw JSON to stdout in production
//   - file:     JSON appended to <LOG_DIR>/server.log in EVERY env (the durable sink)
// The file target always gets parseable JSON (never the colorized pretty stream), and
// mkdir:true means a missing logs/ dir is created rather than crashing boot.
//
// Rotation is intentionally NOT handled here: pino/file appends to a fixed path, so the
// deploy side must rotate with logrotate `copytruncate` (or swap in pino-roll) -- a plain
// rename would leave this stream writing to the moved inode.
// Reject LOG_DIR values containing path traversal sequences (card a49270c0, gauge MEDIUM).
// mkdir:true amplifies the risk: the logger will CREATE the directory, so a traversal
// sequence injected via env could write server.log to an arbitrary location on the host.
function validateLogDir(dir: string): string {
  if (dir.includes('../') || dir.endsWith('..')) {
    throw new Error(`LOG_DIR contains path traversal sequence: ${JSON.stringify(dir)}`)
  }
  return dir
}

export function buildLoggerOptions(env: NodeJS.ProcessEnv = process.env) {
  const logDir = validateLogDir(env.LOG_DIR ?? 'logs')

  const terminalTarget =
    env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : { target: 'pino/file', options: { destination: 1 } } // raw JSON to stdout

  const fileTarget = {
    target: 'pino/file',
    options: { destination: `${logDir}/server.log`, mkdir: true },
  }

  return {
    level: env.LOG_LEVEL ?? 'info',
    transport: { targets: [terminalTarget, fileTarget] },
  }
}

export const logger = pino(buildLoggerOptions())
