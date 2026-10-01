import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { minimatch } from 'minimatch'

// Guards the vitest exclude list against the 2026-10-02 fleet-wedge incident
// (incident-dashboard-wedge-vitest-live-infra-1002, card 381d4123).
//
// The repo-root holds deploy-time backup dirs in two forms -- `dist-backup-*`
// and `dist.backup-*` -- each a full tree with its own `src/__tests__` copy
// (15 dirs / 4600+ test files on 2026-10-02). The config already excludes
// `store/dist-backup-*/**` but NOT these REPO-ROOT forms, so a full
// `vitest run` (the buster CI pre-gate sweep on open PRs) globbed and re-ran
// the stale backup copies -- including a live-infra-hitting test -- and wedged
// the dashboard event loop into a relaunch loop. This test fails if either
// root-backup glob is dropped or stops matching a backup test path.
//
// We read the config SOURCE (tsc won't resolve a repo-root import from
// src/__tests__) and assert the exact quoted globs are present, then confirm
// their match semantics with minimatch (simple enough that minimatch and
// vitest's own picomatch agree).

const ROOT_BACKUP_GLOBS = ['dist-backup-*/**', 'dist.backup-*/**']

function configSource(): string {
  const configPath = fileURLToPath(new URL('../../vitest.config.ts', import.meta.url))
  return readFileSync(configPath, 'utf8')
}

describe('vitest.config exclude: repo-root dist backups (card 381d4123)', () => {
  const source = configSource()
  const isExcluded = (p: string) => ROOT_BACKUP_GLOBS.some((g) => minimatch(p, g))

  it('declares both repo-root backup globs as quoted exclude entries', () => {
    for (const glob of ROOT_BACKUP_GLOBS) {
      expect(source).toContain(`'${glob}'`)
    }
  })

  it('excludes a dash-form backup test path', () => {
    expect(isExcluded('dist-backup-20260822-025132/src/__tests__/x.test.ts')).toBe(true)
  })

  it('excludes a dot-form backup test path', () => {
    expect(isExcluded('dist.backup-20260929-113852-pre-acd7fa13/src/__tests__/x.test.ts')).toBe(true)
  })

  it('does not over-exclude the real repo-root suite', () => {
    expect(isExcluded('src/__tests__/x.test.ts')).toBe(false)
  })
})
