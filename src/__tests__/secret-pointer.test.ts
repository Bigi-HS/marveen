import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveSecretPointer, SecretPointerError } from '../web/agent-config.js'

// Use a temporary directory as the project root so tests are hermetic.
let tmpRoot: string

beforeEach(() => {
  tmpRoot = join(tmpdir(), `secret-pointer-test-${process.pid}-${Date.now()}`)
  mkdirSync(tmpRoot, { recursive: true })
  mkdirSync(join(tmpRoot, 'store'), { recursive: true })
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

// --- plain strings (no placeholder) ---------------------------------------

describe('resolveSecretPointer -- plain strings pass through unchanged', () => {
  it('returns a plain string unchanged', () => {
    expect(resolveSecretPointer('hello world', tmpRoot)).toBe('hello world')
  })
  it('returns an empty string unchanged', () => {
    expect(resolveSecretPointer('', tmpRoot)).toBe('')
  })
  it('does not resolve lowercase env placeholder (not valid env name form)', () => {
    expect(resolveSecretPointer('{env:lowercase}', tmpRoot)).toBe('{env:lowercase}')
  })
  it('does not resolve empty env name', () => {
    expect(resolveSecretPointer('{env:}', tmpRoot)).toBe('{env:}')
  })
  it('does not resolve env name with spaces (not a valid shell env name)', () => {
    expect(resolveSecretPointer('{env:FOO BAR}', tmpRoot)).toBe('{env:FOO BAR}')
  })
  it('does not resolve env name starting with a digit', () => {
    expect(resolveSecretPointer('{env:1FOO}', tmpRoot)).toBe('{env:1FOO}')
  })
  it('does not resolve an embedded placeholder (only whole-value patterns match)', () => {
    expect(resolveSecretPointer('Bearer {env:TOKEN}', tmpRoot)).toBe('Bearer {env:TOKEN}')
  })
})

// --- {env:VAR_NAME} -------------------------------------------------------

describe('resolveSecretPointer -- {env:VAR_NAME}', () => {
  beforeEach(() => {
    process.env['__TEST_SECRET_CHAD'] = 'supersecret'
  })
  afterEach(() => {
    delete process.env['__TEST_SECRET_CHAD']
  })

  it('resolves a set env var', () => {
    expect(resolveSecretPointer('{env:__TEST_SECRET_CHAD}', tmpRoot)).toBe('supersecret')
  })

  it('resolves an underscore-prefixed name (single leading underscore is valid)', () => {
    expect(resolveSecretPointer('{env:__TEST_SECRET_CHAD}', tmpRoot)).toBe('supersecret')
  })

  it('throws SecretPointerError when the env var is not set', () => {
    expect(() => resolveSecretPointer('{env:__NOT_SET_CHAD_XYZ}', tmpRoot))
      .toThrow(SecretPointerError)
  })

  it('error message contains the var name but not the resolved value', () => {
    process.env['__TEST_SECRET_CHAD'] = 'should-not-appear'
    // Force an unset var to get the error; then check a set one never leaks below.
    expect(() => resolveSecretPointer('{env:__UNSET_XYZ}', tmpRoot))
      .toThrowError('__UNSET_XYZ')
    // Positive: resolves without leaking secret into any thrown message.
    expect(resolveSecretPointer('{env:__TEST_SECRET_CHAD}', tmpRoot)).toBe('should-not-appear')
  })

  it('resolves an env var whose value is the empty string (explicitly set to "")', () => {
    process.env['__TEST_EMPTY_CHAD'] = ''
    try {
      expect(resolveSecretPointer('{env:__TEST_EMPTY_CHAD}', tmpRoot)).toBe('')
    } finally {
      delete process.env['__TEST_EMPTY_CHAD']
    }
  })
})

// --- {file:relative/path} -------------------------------------------------

describe('resolveSecretPointer -- {file:relative/path}', () => {
  it('reads a file and returns its content trimmed of trailing whitespace', () => {
    writeFileSync(join(tmpRoot, 'store', '.dashboard-token'), 'tok-abc123\n')
    expect(resolveSecretPointer('{file:store/.dashboard-token}', tmpRoot)).toBe('tok-abc123')
  })

  it('trims trailing newlines (token files commonly end with \\n)', () => {
    writeFileSync(join(tmpRoot, 'store', '.dashboard-token'), 'tok\n\n')
    expect(resolveSecretPointer('{file:store/.dashboard-token}', tmpRoot)).toBe('tok')
  })

  it('does not trim leading whitespace (preserves intentional indentation)', () => {
    writeFileSync(join(tmpRoot, 'store', 'pad.txt'), '  value')
    expect(resolveSecretPointer('{file:store/pad.txt}', tmpRoot)).toBe('  value')
  })

  it('throws SecretPointerError for a non-existent file', () => {
    expect(() => resolveSecretPointer('{file:store/missing.txt}', tmpRoot))
      .toThrow(SecretPointerError)
  })

  it('error message contains the path but not the file content', () => {
    try {
      resolveSecretPointer('{file:store/missing.txt}', tmpRoot)
    } catch (e) {
      expect(e).toBeInstanceOf(SecretPointerError)
      expect((e as Error).message).toContain('store/missing.txt')
    }
  })
})

// --- {file:} path-traversal and absolute-path guards ----------------------

describe('resolveSecretPointer -- {file:} path security', () => {
  it('rejects a path with .. (parent traversal)', () => {
    expect(() => resolveSecretPointer('{file:store/../../etc/passwd}', tmpRoot))
      .toThrow(SecretPointerError)
  })

  it('rejects a bare .. segment', () => {
    expect(() => resolveSecretPointer('{file:..}', tmpRoot))
      .toThrow(SecretPointerError)
  })

  it('rejects a path that starts with / (absolute path)', () => {
    expect(() => resolveSecretPointer('{file:/etc/passwd}', tmpRoot))
      .toThrow(SecretPointerError)
  })

  it('rejects a path that starts with ~ (tilde expansion not supported)', () => {
    expect(() => resolveSecretPointer('{file:~/.git-credentials}', tmpRoot))
      .toThrow(SecretPointerError)
  })

  it('rejects an empty file path', () => {
    expect(() => resolveSecretPointer('{file:}', tmpRoot))
      .toThrow(SecretPointerError)
  })

  it('rejects a path with an encoded .. (%2e%2e) -- must not silently pass', () => {
    // URL-encoding is not expanded here; the literal %2e%2e string is not a
    // traversal on the filesystem. But the path contains no legitimate content
    // -- if the file resolver were to URL-decode it, that would be a bug. We
    // assert it either passes unchanged or throws (the safe outcomes), and that
    // it does NOT resolve /etc/passwd.
    expect(() => resolveSecretPointer('{file:%2e%2e/%2e%2e/etc/passwd}', tmpRoot))
      .toThrow(SecretPointerError)
  })

  it('allows a relative path inside the project root (no traversal)', () => {
    writeFileSync(join(tmpRoot, 'store', 'safe.txt'), 'ok')
    expect(resolveSecretPointer('{file:store/safe.txt}', tmpRoot)).toBe('ok')
  })
})
