import { describe, it, expect } from 'vitest'
import { buildLoggerOptions } from '../logger.js'

// SRE L1a durable log sink (fleet-expansion Phase 1). The load-bearing
// guarantee: regardless of env, one transport target appends JSON to
// <LOG_DIR>/server.log, so a restart no longer wipes the log history
// (08-14: 21h of tmux-scrollback logs lost on deploy-restart). These are
// value-carrying assertions -- they go red if the file sink is dropped or the
// terminal/file split is broken.

type Target = { target: string; options?: Record<string, unknown> }

function targets(env: Record<string, string | undefined>): Target[] {
  const opts = buildLoggerOptions(env as NodeJS.ProcessEnv)
  return (opts.transport as { targets: Target[] }).targets
}

function fileTarget(ts: Target[], dest = 'logs/server.log'): Target | undefined {
  return ts.find((t) => t.target === 'pino/file' && t.options?.destination === dest)
}

describe('buildLoggerOptions level', () => {
  it('defaults to info', () => {
    expect(buildLoggerOptions({} as NodeJS.ProcessEnv).level).toBe('info')
  })
  it('honors LOG_LEVEL', () => {
    expect(buildLoggerOptions({ LOG_LEVEL: 'debug' } as NodeJS.ProcessEnv).level).toBe('debug')
  })
})

describe('durable file sink is present in every env', () => {
  it('dev: pretty terminal + json file', () => {
    const ts = targets({ NODE_ENV: 'development' })
    expect(ts.some((t) => t.target === 'pino-pretty')).toBe(true)
    const f = fileTarget(ts)
    expect(f).toBeDefined()
    expect(f!.options?.mkdir).toBe(true)
  })

  it('production: raw stdout + json file (no pino-pretty)', () => {
    const ts = targets({ NODE_ENV: 'production' })
    // no colorized pretty transport in production
    expect(ts.some((t) => t.target === 'pino-pretty')).toBe(false)
    // terminal target is raw JSON to stdout (destination 1)
    expect(ts.some((t) => t.target === 'pino/file' && t.options?.destination === 1)).toBe(true)
    // the durable file sink is STILL there
    expect(fileTarget(ts)).toBeDefined()
  })
})

describe('LOG_DIR override', () => {
  it('redirects the file sink but keeps the filename', () => {
    const ts = targets({ NODE_ENV: 'production', LOG_DIR: '/tmp/noa-logs' })
    expect(fileTarget(ts, '/tmp/noa-logs/server.log')).toBeDefined()
  })
})

describe('file sink always creates its dir', () => {
  it('mkdir:true in both envs so a missing logs/ cannot crash boot', () => {
    for (const NODE_ENV of ['development', 'production']) {
      const f = fileTarget(targets({ NODE_ENV }))
      expect(f?.options?.mkdir).toBe(true)
    }
  })
})
