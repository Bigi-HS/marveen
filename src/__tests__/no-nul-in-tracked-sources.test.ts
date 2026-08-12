import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// DA-57. A single NUL byte anywhere in a text file removes it from every
// content search we run. GNU grep reports "binary file matches" on STDERR and
// prints no lines, and every audit one-liner we write ends in `2>/dev/null`, so
// the notice is discarded with it. The exit status is still 0. That means a
// tracked source file can silently stop being greppable without anyone touching
// it, and `grep -rn X src/` will answer "not there" about code that is there.
//
// Measured when this was written: src/web/token-usage.ts carried a NUL at
// offset 22188 as a deliberate composite-key delimiter (`${agent}\0${session}`).
// A legitimate idiom, and the file was invisible to content search because of
// it. This guard keeps the tracked tree searchable.
//
// SCOPE, STATED SO A PASS CANNOT BE MISREAD (DA-59). This asserts on TRACKED
// files only, and that is roughly one instance in fifty. When it was written:
// 1 tracked file carried a NUL, against ~49 untracked ones (worktree copies of
// that same file, plus logs and store artifacts). So this suite going green
// means "the committed tree is searchable", NOT "the NUL problem is handled".
// The untracked count is also not a stable number -- agents create and delete
// worktrees continuously, so it moves within the hour and should not be quoted.
//
// It cannot be widened usefully either. Of the three origins measured, only one
// is a bug: a deliberate NUL as an in-band marker is legitimate code, and a
// zero-filled hole from a crashed writer is not something a repo test can
// prevent. The blind set is a permanent property of the tree, so the defence
// that actually matters lives at SEARCH time: grep -a / --binary-files=text.

const REPO_ROOT = join(__dirname, '..', '..')

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.md', '.json', '.py', '.sh', '.bash',
  '.txt', '.yml', '.yaml', '.css', '.html',
])

const MAX_BYTES = 8 * 1024 * 1024

function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out
    .split('\0')
    .filter((p) => p.length > 0)
    .filter((p) => {
      const dot = p.lastIndexOf('.')
      return dot >= 0 && TEXT_EXTENSIONS.has(p.slice(dot).toLowerCase())
    })
}

function filesContainingNul(paths: string[]): { path: string; offset: number }[] {
  const found: { path: string; offset: number }[] = []
  for (const rel of paths) {
    const abs = join(REPO_ROOT, rel)
    let size: number
    try {
      size = statSync(abs).size
    } catch {
      continue // deleted-but-still-indexed; not this test's business
    }
    if (size > MAX_BYTES) continue
    const buf = readFileSync(abs)
    const offset = buf.indexOf(0)
    if (offset !== -1) found.push({ path: rel, offset })
  }
  return found
}

describe('tracked source files stay searchable', () => {
  const tracked = trackedTextFiles()

  // Vacuity guard. A scanner that scans nothing passes every assertion, and
  // that is precisely the failure mode this whole class of bug is made of: a
  // green result that measured an empty set. Assert the denominator before
  // trusting the numerator.
  it('scans a non-empty set that contains known members', () => {
    expect(tracked.length).toBeGreaterThan(100)
    expect(tracked).toContain('src/web/token-usage.ts')
    expect(tracked.some((p) => p.endsWith('.md'))).toBe(true)
  })

  it('detects a NUL when one is present (positive control)', () => {
    // Prove the detector bites, on a buffer with known content. Without this,
    // "0 files found" is indistinguishable from "the check never ran".
    const clean = Buffer.from('const key = `${a}:${b}`\n', 'utf-8')
    const dirty = Buffer.concat([clean, Buffer.from([0]), clean])
    expect(clean.indexOf(0)).toBe(-1)
    expect(dirty.indexOf(0)).toBe(clean.length)
  })

  it('no tracked text file contains a NUL byte', () => {
    const offenders = filesContainingNul(tracked)
    const detail = offenders.map((o) => `${o.path} (first NUL at byte ${o.offset})`)
    expect(detail).toEqual([])
  })
})
