#!/usr/bin/env tsx
/**
 * Move existing agents' permission-rules hook onto the promoted guard path.
 *
 * ensureAgentHooks() already runs this migration for every agent at dashboard
 * boot, which is all-or-nothing. This script exists so the fleet-wide rewrite
 * can be done canary-first: one agent, verified, then the rest.
 *
 * It deliberately runs ONLY ensurePromotedGuardPath, not the whole hook merge
 * chain, so a canary run changes exactly the thing under test and nothing else.
 *
 * Refuses to touch anything unless the promoted guard is actually promoted and
 * its manifest matches. Pointing agents at a file no gate ever wrote would be
 * worse than the hole this closes: a missing hook script fails on every tool
 * call, and a stale one enforces rules nobody reviewed.
 *
 *   tsx scripts/migrate-guard-path.ts --agent buster          # dry run
 *   tsx scripts/migrate-guard-path.ts --agent buster --apply
 *   tsx scripts/migrate-guard-path.ts --all --apply
 */
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { PROJECT_ROOT } from '../src/config.js'
import { ensurePromotedGuardPath } from '../src/web/agent-scaffold.js'
import { atomicWriteFileSync } from '../src/web/atomic-write.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const all = args.includes('--all')
const agentArg = args[args.indexOf('--agent') + 1]

function templateHooks(): Record<string, unknown> {
  const tplPath = join(PROJECT_ROOT, 'templates', 'settings.json.template')
  const raw = readFileSync(tplPath, 'utf-8').replaceAll('{{PROJECT_ROOT}}', PROJECT_ROOT)
  return (JSON.parse(raw) as { hooks: Record<string, unknown> }).hooks
}

/** Fail-closed: the destination must be a promoted file whose manifest matches. */
function requirePromotedGuard(): void {
  const out = execFileSync('python3', [join(PROJECT_ROOT, 'scripts', 'promote-guard.py'), '--verify'],
    { encoding: 'utf-8' })
  if (!/promoted=True\s+manifest_ok=True/.test(out)) {
    throw new Error(`refusing to migrate: the promoted guard did not verify\n${out}`)
  }
}

function agentNames(): string[] {
  if (agentArg && !agentArg.startsWith('--')) return [agentArg]
  if (!all) throw new Error('pass --agent <name> or --all')
  return readdirSync(join(PROJECT_ROOT, 'agents'), { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort()
}

requirePromotedGuard()
const tpl = templateHooks()
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const backupDir = join('/tmp', 'marveen-deploy-backups', stamp)

let changed = 0
for (const name of agentNames()) {
  const settingsPath = join(PROJECT_ROOT, 'agents', name, '.claude', 'settings.json')
  if (!existsSync(settingsPath)) continue
  let settings: Record<string, unknown>
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch (err) {
    console.log(`${name.padEnd(16)} SKIP  unparseable settings.json (${(err as Error).message})`)
    continue
  }
  if (!settings.hooks) {
    console.log(`${name.padEnd(16)} skip  no hooks block`)
    continue
  }
  const dirty = ensurePromotedGuardPath(settings.hooks as never, tpl as never)
  if (!dirty) {
    console.log(`${name.padEnd(16)} ok    already on the promoted path`)
    continue
  }
  changed++
  if (!apply) {
    console.log(`${name.padEnd(16)} WOULD migrate (dry run)`)
    continue
  }
  mkdirSync(backupDir, { recursive: true })
  copyFileSync(settingsPath, join(backupDir, `${name}-settings.json`))
  atomicWriteFileSync(settingsPath, JSON.stringify(settings, null, 2))
  console.log(`${name.padEnd(16)} MIGRATED (backup: ${backupDir}/${name}-settings.json)`)
}

console.log(`\n${changed} agent(s) ${apply ? 'migrated' : 'would be migrated'}.`)
if (changed && apply) {
  console.log('The hook is read at session start, so each agent picks this up on its next launch.')
}
