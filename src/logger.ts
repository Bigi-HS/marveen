import pino from 'pino'
import { appendFileSync, mkdirSync } from 'node:fs'
import { hostname } from 'node:os'

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

// Last-gasp SYNCHRONOUS crash logger (card 0cc1e31b). The pino logger above fans
// the log out through a multi-target transport that runs in a WORKER THREAD
// (thread-stream). On a fatal crash the main process calls process.exit() before
// that worker drains its buffer, so a plain logger.fatal() is routinely LOST from
// server.log -- which is why every prior silent server death was a black box.
//
// This bypasses the async transport entirely: it serialises the crash record to
// the SAME <LOG_DIR>/server.log with a synchronous O_APPEND write (atomic for a
// single sub-PIPE_BUF line on Linux, so it never interleaves mid-line with the
// transport's own output) and returns only once the bytes are handed to the
// kernel. The record is shaped like a pino line (level/time/pid/hostname/msg) so
// existing log tooling parses it unchanged. Best-effort and NEVER throws: a
// failed durable write must not mask the original crash, so it falls back to
// stderr and gives up quietly. LOG_DIR is re-read (and re-validated) on each call
// so the path always matches the live logger config.
export function logCrashSync(
  event: string,
  err: unknown,
  opts: { origin?: string; level?: number } = {},
): void {
  const level = opts.level ?? 60 // pino fatal
  try {
    const e = err as { name?: string; message?: string; stack?: string }
    const serialisedErr =
      err instanceof Error
        ? { type: e.name, message: e.message, stack: e.stack }
        : { message: String(err) }
    const rec = {
      level,
      time: Date.now(),
      pid: process.pid,
      hostname: hostname(),
      event,
      ...(opts.origin ? { origin: opts.origin } : {}),
      err: serialisedErr,
      msg: `${event}: server crash trace (last-gasp sync flush)`,
    }
    const logDir = validateLogDir(process.env.LOG_DIR ?? 'logs')
    mkdirSync(logDir, { recursive: true })
    appendFileSync(`${logDir}/server.log`, JSON.stringify(rec) + '\n')
  } catch (writeErr) {
    // Truly last-gasp: never let the durable-log write itself mask the crash.
    try {
      process.stderr.write(
        `FATAL ${event} (durable log failed: ${String(writeErr)}): ${String(err)}\n`,
      )
    } catch {
      /* give up */
    }
  }
}
