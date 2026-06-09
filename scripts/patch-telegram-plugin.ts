#!/usr/bin/env tsx
// pipe-RCA #2 (card 81cf42b2): apply the 409-give-up -> capped-exponential-backoff
// fix to the locally-installed Telegram channel plugin.
//
// The fix lives in a third-party plugin file outside this repo
// (~/.claude/plugins/.../telegram/.../server.ts), so we cannot ship it as a
// normal source edit. This idempotent patcher carries the change in-repo and
// applies it to every cached + marketplace copy of the plugin. The transform
// itself is the unit-tested pure function in src/telegram-plugin-patch.ts.
//
//   tsx scripts/patch-telegram-plugin.ts            apply (idempotent)
//   tsx scripts/patch-telegram-plugin.ts --check     report only; exit 1 if any
//                                                     patchable file is unpatched
//   tsx scripts/patch-telegram-plugin.ts --revert     restore the .prepatch-backup
//
// Safety: each file is backed up to <file>.prepatch-backup before the first
// write; the patched output is syntax-gated (TypeScript transpile) and the
// backup is restored if the gate fails. The plugin file holds no secrets, and
// this script neither reads nor prints any token.

import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { PATCH_MARKER, patchPollingGiveUp } from '../src/telegram-plugin-patch.js'

const require = createRequire(import.meta.url)

const PLUGIN_ROOTS = [
  join(homedir(), '.claude', 'plugins', 'cache'),
  join(homedir(), '.claude', 'plugins', 'marketplaces'),
]
const BACKUP_SUFFIX = '.prepatch-backup'

// Recursively collect telegram-plugin server.ts files under a root (bounded
// depth so a pathological tree can't hang the walk).
function findTelegramServers(root: string, depth = 0): string[] {
  if (depth > 8 || !existsSync(root)) return []
  const out: string[] = []
  let entries: string[]
  try { entries = readdirSync(root) } catch { return [] }
  for (const name of entries) {
    const p = join(root, name)
    // lstat (not stat): never follow a symlink -- a symlinked dir or file inside
    // the (owner-only) plugin cache must not redirect the walk or the write.
    let st
    try { st = lstatSync(p) } catch { continue }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) {
      out.push(...findTelegramServers(p, depth + 1))
    } else if (name === 'server.ts' && p.toLowerCase().includes('telegram')) {
      out.push(p)
    }
  }
  return out
}

// Syntax-only gate: transpile the patched source and fail on any syntactic
// diagnostic. Type errors are ignored (the plugin's deps are not installed here);
// we only guard against a malformed edit. Returns null on success, else a reason.
function syntaxError(src: string, file: string): string | null {
  let ts: typeof import('typescript')
  try { ts = require('typescript') } catch {
    process.stderr.write('  ! typescript not available -- skipping the syntax gate (transform is a deterministic string edit; --revert backs up regardless)\n')
    return null
  }
  const res = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
    fileName: file,
  })
  const fatal = (res.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error)
  if (fatal.length === 0) return null
  return fatal.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('; ')
}

function applyOne(file: string): 'patched' | 'already' | 'not-found' | 'gate-failed' {
  const src = readFileSync(file, 'utf-8')
  const r = patchPollingGiveUp(src)
  if (r.alreadyPatched) return 'already'
  if (!r.found || !r.changed) return 'not-found'
  const err = syntaxError(r.patched, file)
  if (err) {
    process.stderr.write(`  ! syntax gate FAILED, not writing: ${err}\n`)
    return 'gate-failed'
  }
  const backup = file + BACKUP_SUFFIX
  if (!existsSync(backup)) copyFileSync(file, backup)
  // Atomic write: stage to a temp file then rename, so a crash mid-write can
  // never leave a half-written (corrupt) plugin file behind.
  const tmp = file + '.patch-tmp'
  writeFileSync(tmp, r.patched)
  renameSync(tmp, file)
  return 'patched'
}

function revertOne(file: string): boolean {
  const backup = file + BACKUP_SUFFIX
  if (!existsSync(backup)) return false
  copyFileSync(backup, file)
  return true
}

function main(): void {
  const mode = process.argv[2] ?? '--apply'
  const files = PLUGIN_ROOTS.flatMap(r => findTelegramServers(r))
  if (files.length === 0) {
    process.stdout.write('No telegram plugin server.ts found under ~/.claude/plugins (nothing to do).\n')
    return
  }

  if (mode === '--check') {
    let unpatched = 0
    for (const f of files) {
      const src = readFileSync(f, 'utf-8')
      const patched = src.includes(PATCH_MARKER)
      const patchable = !patched && patchPollingGiveUp(src).found
      process.stdout.write(`  ${patched ? 'PATCHED ' : patchable ? 'UNPATCHED' : 'n/a      '}  ${f}\n`)
      if (patchable) unpatched++
    }
    if (unpatched > 0) {
      process.stdout.write(`${unpatched} patchable file(s) still unpatched.\n`)
      process.exit(1)
    }
    process.stdout.write('All telegram plugin copies are patched (or not applicable).\n')
    return
  }

  if (mode === '--revert') {
    let n = 0
    for (const f of files) if (revertOne(f)) { n++; process.stdout.write(`  reverted ${f}\n`) }
    process.stdout.write(`Reverted ${n} file(s) from ${BACKUP_SUFFIX}.\n`)
    return
  }

  // default: apply
  const tally: Record<string, number> = { patched: 0, already: 0, 'not-found': 0, 'gate-failed': 0 }
  for (const f of files) {
    const res = applyOne(f)
    tally[res]++
    process.stdout.write(`  ${res.padEnd(11)} ${f}\n`)
  }
  process.stdout.write(
    `Done: ${tally.patched} patched, ${tally.already} already, ` +
    `${tally['not-found']} no-match, ${tally['gate-failed']} gate-failed.\n`,
  )
  if (tally['gate-failed'] > 0) process.exit(1)
}

main()
