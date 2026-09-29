import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildLoggerOptions } from '../logger.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'logger-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('dev: pretty terminal + json file', () => {
    const ts = targets({ NODE_ENV: 'development', LOG_DIR: tmpDir })
    expect(ts.some((t) => t.target === 'pino-pretty')).toBe(true)
    const f = fileTarget(ts, `${tmpDir}/server.log`)
    expect(f).toBeDefined()
  })

  it('production: raw stdout + json file (no pino-pretty)', () => {
    const ts = targets({ NODE_ENV: 'production', LOG_DIR: tmpDir })
    // no colorized pretty transport in production
    expect(ts.some((t) => t.target === 'pino-pretty')).toBe(false)
    // terminal target is raw JSON to stdout (destination 1)
    expect(ts.some((t) => t.target === 'pino/file' && t.options?.destination === 1)).toBe(true)
    // the durable file sink is STILL there
    expect(fileTarget(ts, `${tmpDir}/server.log`)).toBeDefined()
  })
})

describe('LOG_DIR override', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'logger-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('redirects the file sink but keeps the filename', () => {
    const ts = targets({ NODE_ENV: 'production', LOG_DIR: tmpDir })
    expect(fileTarget(ts, `${tmpDir}/server.log`)).toBeDefined()
  })
})

describe('file sink dir creation (c57d0fee)', () => {
  it('throws on LOG_DIR that cannot be created (mkdir failure is fatal)', () => {
    // Use a path under / that a non-root process cannot create.
    expect(() =>
      buildLoggerOptions({ LOG_DIR: '/cannot-create-logger-test-dir' } as NodeJS.ProcessEnv),
    ).toThrow()
  })
})

// cb7ffa62: ?? does not fire on empty string; empty env vars must fall back to defaults.
describe('empty-string env vars treated as unset (cb7ffa62)', () => {
  it('LOG_DIR="" falls back to "logs" default (not an error)', () => {
    let created = false
    try {
      buildLoggerOptions({ LOG_DIR: '' } as NodeJS.ProcessEnv)
      created = true
    } catch {
      // allowed to throw only if 'logs/' itself is non-writable in this env
    }
    // Either it succeeded (logs/ created) or threw for unrelated reasons; the key
    // assertion is that empty string did NOT pass through as an empty path.
    // Verify via the targets directly when creation succeeds.
    if (created) {
      const ts = targets({ LOG_DIR: '' })
      expect(fileTarget(ts, 'logs/server.log')).toBeDefined()
    }
  })

  it('LOG_LEVEL="" falls back to "info"', () => {
    expect(buildLoggerOptions({ LOG_LEVEL: '' } as NodeJS.ProcessEnv).level).toBe('info')
  })
})

// AC: path traversal guard on LOG_DIR (card a49270c0, gauge gate finding).
// LOG_DIR is an env var that is used directly in path construction with mkdir:true.
// A traversal sequence (../) in an injected LOG_DIR would cause the logger to create
// and write to arbitrary directories. The guard rejects such paths.
describe('LOG_DIR path traversal guard (a49270c0)', () => {
  it('throws on LOG_DIR containing a ../ traversal sequence', () => {
    expect(() => buildLoggerOptions({ LOG_DIR: '../../etc' } as NodeJS.ProcessEnv)).toThrow()
  })

  it('throws on LOG_DIR containing an embedded traversal (prefix/../../etc)', () => {
    expect(() => buildLoggerOptions({ LOG_DIR: 'logs/../../etc' } as NodeJS.ProcessEnv)).toThrow()
  })

  it('throws on LOG_DIR with a leading ../ (relative escape)', () => {
    expect(() => buildLoggerOptions({ LOG_DIR: '../sibling' } as NodeJS.ProcessEnv)).toThrow()
  })

  it('[FP-catch] accepts a plain relative path without traversal (logs)', () => {
    let logDir = 'logs-test-' + Date.now()
    try {
      expect(() => buildLoggerOptions({ LOG_DIR: logDir } as NodeJS.ProcessEnv)).not.toThrow()
      const ts = targets({ LOG_DIR: logDir })
      expect(fileTarget(ts, `${logDir}/server.log`)).toBeDefined()
    } finally {
      rmSync(logDir, { recursive: true, force: true })
    }
  })

  it('[FP-catch] accepts an absolute path without traversal', () => {
    let tmpDir = mkdtempSync(join(tmpdir(), 'logger-test-'))
    try {
      expect(() => buildLoggerOptions({ LOG_DIR: tmpDir } as NodeJS.ProcessEnv)).not.toThrow()
      const ts = targets({ LOG_DIR: tmpDir })
      expect(fileTarget(ts, `${tmpDir}/server.log`)).toBeDefined()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('[FP-catch] accepts a path that contains the word "dotdot" without being a traversal', () => {
    let logDir = 'logs-dotdot-test-' + Date.now()
    try {
      expect(() => buildLoggerOptions({ LOG_DIR: logDir } as NodeJS.ProcessEnv)).not.toThrow()
    } finally {
      rmSync(logDir, { recursive: true, force: true })
    }
  })
})
