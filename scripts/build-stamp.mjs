#!/usr/bin/env node
// build-stamp.mjs -- write the source SHA into dist/.built-from at build time.
//
// Invoked as a post-build step (package.json "build": "tsc && node scripts/build-stamp.mjs").
// The stamp lives INSIDE dist/ so it survives the `rsync -a <worktree>/dist/ dist/` copy
// used by the isolated-worktree deploy path. This lets C4 in deploy-preflight-unifier.sh
// assert provenance (which commit the dist was built from) instead of only recency
// (whether dist/index.js is newer than the last src commit).
//
// ENG-048 class: a dist built from a parked/wrong branch passes the recency check
// because recency only proves the build is not stale, not that it is from the right ref.
// The stamp closes that gap: C4 can now compare dist/.built-from against the deployment
// target and fail when they differ.
//
// Usage: called automatically by `npm run build`. Safe to run manually.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Use process.cwd() so this script works correctly whether called as
// `npm run build` (cwd = repo root) or from a test fixture dir.
const repoRoot = process.cwd()
const stampFile = join(repoRoot, 'dist', '.built-from')

let sha
try {
  sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
} catch (err) {
  console.error('build-stamp: git rev-parse HEAD failed:', err.message)
  process.exit(1)
}

writeFileSync(stampFile, sha + '\n', 'utf8')
console.log(`build-stamp: dist/.built-from = ${sha.slice(0, 8)}`)
