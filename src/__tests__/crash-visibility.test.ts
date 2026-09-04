import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logCrashSync } from '../logger.js'

// Card 0cc1e31b. pino's multi-target transport runs in a WORKER THREAD, so a
// plain logger.fatal() issued right before process.exit() is routinely LOST from
// server.log -- every prior silent server death was a black box. logCrashSync
// writes the crash record SYNCHRONOUSLY and directly to <LOG_DIR>/server.log so
// the trace is durable regardless of the async transport's drain state.
describe('logCrashSync (crash-visibility, card 0cc1e31b)', () => {
  let dir: string
  let prevLogDir: string | undefined

  beforeEach(() => {
    prevLogDir = process.env.LOG_DIR
    dir = mkdtempSync(join(tmpdir(), 'crashvis-'))
    process.env.LOG_DIR = dir
  })
  afterEach(() => {
    if (prevLogDir === undefined) delete process.env.LOG_DIR
    else process.env.LOG_DIR = prevLogDir
    rmSync(dir, { recursive: true, force: true })
  })

  function readLines(): any[] {
    const raw = readFileSync(join(dir, 'server.log'), 'utf-8').trim()
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  }

  it('writes a durable, pino-parseable fatal line for an Error, with stack + origin', () => {
    logCrashSync('uncaughtException', new Error('boom-uncaught'), { origin: 'uncaughtException' })
    const [rec] = readLines()
    expect(rec.level).toBe(60) // pino fatal
    expect(rec.event).toBe('uncaughtException')
    expect(rec.origin).toBe('uncaughtException')
    expect(rec.err.type).toBe('Error')
    expect(rec.err.message).toBe('boom-uncaught')
    expect(rec.err.stack).toContain('boom-uncaught')
    expect(typeof rec.time).toBe('number')
    expect(rec.pid).toBe(process.pid)
    expect(rec.msg).toContain('uncaughtException')
  })

  it('serialises a non-Error reason and honours a custom level', () => {
    logCrashSync('unhandledRejection', 'plain-string-reason', { level: 50 })
    const [rec] = readLines()
    expect(rec.level).toBe(50) // pino error
    expect(rec.event).toBe('unhandledRejection')
    expect(rec.err.message).toBe('plain-string-reason')
  })

  it('APPENDS (never truncates) so back-to-back crashes are all preserved', () => {
    logCrashSync('uncaughtException', new Error('first'))
    logCrashSync('unhandledRejection', new Error('second'), { level: 50 })
    const lines = readLines()
    expect(lines).toHaveLength(2)
    expect(lines[0].err.message).toBe('first')
    expect(lines[1].err.message).toBe('second')
  })

  it('creates a missing log dir and never throws (best-effort last-gasp)', () => {
    const nested = join(dir, 'nested', 'logs')
    process.env.LOG_DIR = nested
    expect(() => logCrashSync('uncaughtException', new Error('mkdir-path'))).not.toThrow()
    expect(existsSync(join(nested, 'server.log'))).toBe(true)
  })

  it('never throws on a null/odd reason', () => {
    expect(() => logCrashSync('unhandledRejection', null, { level: 50 })).not.toThrow()
    const [rec] = readLines()
    expect(rec.err.message).toBe('null')
  })
})
