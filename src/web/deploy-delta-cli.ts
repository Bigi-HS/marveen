// One-shot CLI for the deploy-delta tracker. Two subcommands:
//
//   deploy-delta record --type <dashboard|launch-env> [--sha <sha>] [--note "..."]
//       Persist the activated tip to store/deploy-state.json. Run this as part
//       of a deploy (after the build/restart) so the baseline is precise.
//
//   deploy-delta report [--head <ref>] [--json] [--notify]
//       Print the merged-but-undeployed delta against <ref> (default
//       origin/develop), flagging behaviour-changing PRs. --notify posts a
//       one-line summary to Genesis via inter-agent ONLY when the delta is
//       non-empty (best-effort; never fails the report).
//
// Pure visibility: this never deploys and never triggers a deploy. The
// Genesis-GO for an actual restart stays a manual human decision.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { request } from 'node:http'
import { PROJECT_ROOT } from '../config.js'
import { type DeployType, formatDelta, recordDeploy, reportDelta } from './deploy-delta.js'

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}

function notifyGenesis(summary: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tokenPath = join(PROJECT_ROOT, 'store', '.dashboard-token')
      if (!existsSync(tokenPath)) return resolve()
      const token = readFileSync(tokenPath, 'utf-8').trim()
      const body = JSON.stringify({ from: 'dave', to: 'marveen', content: summary })
      const req = request(
        {
          host: '127.0.0.1',
          port: 3420,
          path: '/api/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 5000,
        },
        (res) => {
          res.resume()
          res.on('end', () => resolve())
        },
      )
      req.on('error', () => resolve())
      req.on('timeout', () => {
        req.destroy()
        resolve()
      })
      req.write(body)
      req.end()
    } catch {
      resolve()
    }
  })
}

async function main(): Promise<void> {
  const [sub, ...argv] = process.argv.slice(2)

  if (sub === 'record') {
    const type = argVal(argv, '--type') as DeployType | undefined
    if (type !== 'dashboard' && type !== 'launch-env') {
      process.stderr.write('deploy-delta record: --type must be "dashboard" or "launch-env"\n')
      process.exit(2)
    }
    const state = recordDeploy({ type, sha: argVal(argv, '--sha'), note: argVal(argv, '--note') ?? null })
    process.stdout.write(
      `deploy-delta=recorded sha=${state.deployedSha.slice(0, 8)} type=${state.deployType} at=${state.deployedAt}\n`,
    )
    process.exit(0)
  }

  if (sub === 'report') {
    const delta = reportDelta(argVal(argv, '--head') ?? 'origin/develop')
    if (argv.includes('--json')) {
      process.stdout.write(JSON.stringify(delta, null, 2) + '\n')
    } else {
      process.stdout.write(formatDelta(delta) + '\n')
    }
    if (argv.includes('--notify') && delta.ahead > 0) {
      await notifyGenesis(formatDelta(delta))
    }
    process.exit(0)
  }

  process.stderr.write('usage: deploy-delta <record|report> [opts]\n')
  process.exit(2)
}

void main()
