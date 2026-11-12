// Regression guard for the web-push ESM import style used by the push route.
//
// Incident 2026-11-12: a full develop deploy crashed at Node boot with
//   SyntaxError: The requested module 'web-push' does not provide an export named 'default'
// because src/web/routes/push.ts used a DEFAULT import (`import webpush from 'web-push'`)
// while the installed web-push@4 is a native ESM package that exposes ONLY named
// exports (no default). tsc stayed green because @types/web-push@3 still declares
// a default-compatible shape under esModuleInterop, and vitest's vite transpile
// synthesises a default too -- so neither the compiler nor the normal unit tests
// reproduced the failure. Only a real Node ESM load did.
//
// This test runs under Node's NATIVE ESM loader (via a child process) so it
// reflects the exact semantics the dashboard server boots with, independent of
// vite's interop. It fails if web-push ever stops providing the named exports
// push.ts relies on, or if someone reintroduces a default-import assumption.

import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'

function nodeEsm(code: string) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    cwd: process.cwd(),
    timeout: 20_000,
  })
}

describe('web-push ESM import contract (push route boot guard)', () => {
  it('exposes the named exports the push route uses, under Node-native ESM', () => {
    const r = nodeEsm(`
      import * as wp from 'web-push'
      const ok = typeof wp.setVapidDetails === 'function'
        && typeof wp.sendNotification === 'function'
      if (!ok) { console.error('missing named exports'); process.exit(2) }
      process.exit(0)
    `)
    expect(r.stderr || '').not.toContain('missing named exports')
    expect(r.status).toBe(0)
  })

  it('has NO default export, so a default import of web-push boots-crashes', () => {
    // Reproduces the incident: a default import against a named-only ESM module
    // throws at load time ("does not provide an export named 'default'").
    const r = nodeEsm(`
      import webpush from 'web-push'
      // never reached if web-push lacks a default export
      void webpush
      process.exit(0)
    `)
    expect(r.status).not.toBe(0)
    expect(r.stderr || '').toContain("does not provide an export named 'default'")
  })

  it('loads the compiled push route under Node-native ESM without crashing (when built)', () => {
    // Faithful boot-smoke: if dist is present, importing the real route must not
    // throw the ESM-interop error. Skips silently when dist is not built so the
    // test stays green in source-only CI worktrees.
    const r = nodeEsm(`
      import { existsSync } from 'node:fs'
      import { pathToFileURL } from 'node:url'
      import { join } from 'node:path'
      const p = join(process.cwd(), 'dist', 'web', 'routes', 'push.js')
      if (!existsSync(p)) { console.log('SKIP-no-dist'); process.exit(0) }
      await import(pathToFileURL(p).href)
      process.exit(0)
    `)
    if ((r.stdout || '').includes('SKIP-no-dist')) {
      expect(r.status).toBe(0)
      return
    }
    expect(r.stderr || '').not.toContain("does not provide an export named 'default'")
    expect(r.status).toBe(0)
  })
})
