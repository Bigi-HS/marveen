#!/usr/bin/env -S npx tsx
// Card 9118c069: thin tsx entrypoint for the phantom-runner planner.
//
// Reads a phantom-task-manifest directory (one JSON task per file, per the
// phantom-task-manifest skill / card 52ec0377) and prints the ExecutionPlan as
// JSON on stdout. The plan is then fed to the sandboxed Workflow executor:
//
//   npx tsx scripts/phantom-plan.ts <manifest-dir> [model] > /tmp/plan.json
//   # then run the phantom-executor workflow with args = the parsed plan JSON
//
// All planning (parse/validate/conflict/wave) lives in src/phantom/runner.ts so
// it is unit-tested; this file is only the file IO + CLI glue (not in the tsc
// include set, run via tsx).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planManifest, DEFAULT_PHANTOM_MODEL } from '../src/phantom/runner.js'

function readManifestDir(dir: string): unknown[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort()
  if (files.length === 0) {
    throw new Error(`no .json manifest task files in ${dir}`)
  }
  return files.map(f => {
    const path = join(dir, f)
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch (err) {
      throw new Error(`invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

function main(argv: string[]): number {
  const dir = argv[2]
  if (!dir) {
    process.stderr.write('usage: phantom-plan.ts <manifest-dir> [model]\n')
    return 2
  }
  const model = argv[3] ?? DEFAULT_PHANTOM_MODEL
  const repo = process.env.MARVEEN_ROOT ?? '/home/domin/marveen'

  let rawTasks: unknown[]
  try {
    rawTasks = readManifestDir(dir)
  } catch (err) {
    process.stderr.write(`phantom-plan: ${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  const plan = planManifest(rawTasks, { repo, model })
  if (!plan.ok) {
    process.stderr.write('phantom-plan: manifest invalid:\n  ' + plan.errors.join('\n  ') + '\n')
    return 1
  }

  process.stdout.write(JSON.stringify(plan, null, 2) + '\n')
  return 0
}

process.exit(main(process.argv))
