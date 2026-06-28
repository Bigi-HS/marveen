#!/usr/bin/env tsx
// Applies two idempotent transforms to the locally-installed Telegram channel plugin:
//   1. pipe-RCA #2 (card 81cf42b2): 409 permanent give-up -> capped exponential backoff.
//   2. voice-in auto-transcription (card 45478ca7): message:voice -> whisper "[Hang átirat]:" inject.
//
// The fixes live in third-party plugin files outside this repo
// (~/.claude/plugins/.../telegram/.../server.ts), so we cannot ship them as
// normal source edits. This idempotent patcher carries the changes in-repo and
// applies them to every cached + marketplace copy of the plugin. The transforms
// themselves are unit-tested pure functions in src/telegram-plugin-patch.ts and
// src/telegram-voice-patch.ts.
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
import { VOICE_PATCH_MARKER, patchVoiceHandler } from '../src/telegram-voice-patch.js'

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

  // Chain both transforms. Each is idempotent; apply them sequentially so a
  // single backup + syntax-gate pass covers both changes atomically.
  const r1 = patchPollingGiveUp(src)
  const r2 = patchVoiceHandler(r1.patched)

  const anyFound = r1.found || r2.found
  const anyChanged = r1.changed || r2.changed

  if (!anyFound) return 'not-found'
  if (!anyChanged) return 'already'

  const err = syntaxError(r2.patched, file)
  if (err) {
    process.stderr.write(`  ! syntax gate FAILED, not writing: ${err}\n`)
    return 'gate-failed'
  }
  const backup = file + BACKUP_SUFFIX
  if (!existsSync(backup)) copyFileSync(file, backup)
  // Atomic write: stage to a temp file then rename, so a crash mid-write can
  // never leave a half-written (corrupt) plugin file behind.
  const tmp = file + '.patch-tmp'
  writeFileSync(tmp, r2.patched)
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
      const p1 = src.includes(PATCH_MARKER)
      const p2 = src.includes(VOICE_PATCH_MARKER)
      const patched = p1 && p2
      const patchable1 = !p1 && patchPollingGiveUp(src).found
      const patchable2 = !p2 && patchVoiceHandler(src).found
      const patchable = patchable1 || patchable2
      const label = patched ? 'PATCHED  ' : patchable ? 'UNPATCHED' : 'n/a      '
      const detail = patched ? '' : ` [${[!p1 && 'pipe-rca2', !p2 && 'voice'].filter(Boolean).join(',')}]`
      process.stdout.write(`  ${label}  ${f}${detail}\n`)
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
