// C12 chameleon canary harness CLI (kanban 6d8b5f70).
//
// Usage (run with tsx from the project root):
//   tsx scripts/chameleon.ts morph <target>     rebuild the sandbox as a clone of <target>
//   tsx scripts/chameleon.ts smoke [--keep]      launch + survive + answer-ping on the sandbox
//   tsx scripts/chameleon.ts promote <target> --confirm   copy validated files to the live target
//   tsx scripts/chameleon.ts revert              clean rebuild of the sandbox to baseline
//
// All four operate ONLY on the persistent sandbox agent ("buster", session
// agent-buster). They never touch a live agent except promote, which writes a
// caller-specified, banner-free, channel-free subset and backs up first.

import {
  morphSandbox,
  smokeTestSandbox,
  promoteToLive,
  revertSandboxToBaseline,
  SANDBOX_AGENT,
} from '../src/web/chameleon-harness.js'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'
const ok = (m: string) => console.log(`${GREEN}OK${RESET} ${m}`)
const fail = (m: string) => console.log(`${RED}FAIL${RESET} ${m}`)
const warn = (m: string) => console.log(`${YELLOW}!${RESET} ${m}`)

function usage(): never {
  console.log(
    [
      'C12 chameleon harness',
      '',
      `  morph <target>            rebuild the sandbox ("${SANDBOX_AGENT}") as a clone of <target>`,
      '  smoke [--keep]            launch + survive + answer-ping on the sandbox',
      '  promote <target> --confirm  copy validated files from the sandbox to the live target',
      '  revert                    clean rebuild of the sandbox to baseline',
    ].join('\n'),
  )
  process.exit(2)
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'morph': {
      const target = rest[0]
      if (!target) usage()
      const r = morphSandbox(target)
      if (r.ok) { ok(`sandbox morphed into "${target}"`); return }
      fail(r.error ?? 'morph failed'); process.exit(1); break
    }
    case 'smoke': {
      const keepRunning = rest.includes('--keep')
      const r = await smokeTestSandbox({ keepRunning })
      console.log(JSON.stringify(r, null, 2))
      if (r.verdict === 'pass') { ok('smoke test passed'); return }
      fail(`smoke test verdict: ${r.verdict}`); process.exit(1); break
    }
    case 'promote': {
      const target = rest[0]
      if (!target) usage()
      const confirm = rest.includes('--confirm')
      if (!confirm) { warn('promotion writes to a LIVE agent; re-run with --confirm'); process.exit(2) }
      const r = promoteToLive(target, { confirm: true })
      if (r.ok) { ok(`promoted ${r.promoted.join(', ')} to "${target}" (backup: ${r.backupDir})`); return }
      fail(r.error ?? 'promote failed'); process.exit(1); break
    }
    case 'revert': {
      const r = revertSandboxToBaseline()
      if (r.ok) { ok('sandbox reverted to baseline (clean rebuild)'); return }
      fail(r.error ?? 'revert failed'); process.exit(1); break
    }
    default:
      usage()
  }
}

main().catch(err => {
  fail(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
