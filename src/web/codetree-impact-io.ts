// Real (git / filesystem / DB) wiring for the codetree impact motor. The
// orchestration logic lives in codetree-impact.ts and is unit-tested with
// injected stubs; this module only builds the production ImpactDeps so the
// route stays thin. git is run via execFileSync argv (never a shell string)
// so a card id / ref can never be interpolated into a command.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { getKanbanCard, searchAgentMemories } from '../db.js'
import { queryImporters, queryAllSymbols, getIndexedAtEpoch } from './codetree-db.js'
import type { ImpactDeps } from './codetree-impact.js'

const GIT = '/usr/bin/git'
const STALE_AFTER_SECONDS = 24 * 3600
const SPECS_DIR = join(STORE_DIR, 'specs')
const MEMORY_LIMIT = 10

function gitSafe(args: string[]): string {
  try {
    return execFileSync(GIT, args, { cwd: PROJECT_ROOT, timeout: 5000, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

function lines(out: string): string[] {
  return out.split('\n').map((l) => l.trim()).filter(Boolean)
}

function readSpecCorpus(): Array<{ path: string; text: string }> {
  try {
    return readdirSync(SPECS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ path: `store/specs/${f}`, text: readFileSync(join(SPECS_DIR, f), 'utf-8') }))
  } catch {
    return []
  }
}

function isStale(epoch: number | null): boolean {
  if (epoch == null) return true
  return Math.floor(Date.now() / 1000) - epoch > STALE_AFTER_SECONDS
}

export function realImpactDeps(opts: { agent?: string } = {}): ImpactDeps {
  return {
    importersOf: (file) => queryImporters(file).map((r) => r.from_file),
    allSymbols: queryAllSymbols,
    specCorpus: readSpecCorpus,
    searchHotMemory: (keywords) => {
      const agent = opts.agent
      const q = keywords.slice(0, 8).join(' ')
      if (!agent || !q) return []
      // hot + shared memories are the fleet-relevant tiers for change-impact /
      // spec-init; warm/cold config + archive would just add noise.
      return searchAgentMemories(agent, q, MEMORY_LIMIT)
        .filter((m) => m.category === 'hot' || m.category === 'shared')
        .map((m) => ({ id: m.id, content: m.content, category: m.category, keywords: m.keywords }))
    },
    getCard: (id) => {
      const card = getKanbanCard(id)
      return card ? { title: card.title, description: card.description } : null
    },
    getCardFiles: (id) => {
      // A branch eng/eph-<id>-* means code already exists -> resolve concrete
      // changed files (the precise gate/TDD blast radius). No branch -> null,
      // and the orchestrator falls back to keyword resolution (spec-init).
      const refs = lines(
        gitSafe([
          'for-each-ref',
          '--format=%(refname:short)',
          `refs/heads/eng/eph-${id}*`,
          `refs/remotes/origin/eng/eph-${id}*`,
        ]),
      )
      if (refs.length === 0) return null
      const branch = refs[0]
      return lines(gitSafe(['diff', '--name-only', `origin/develop...${branch}`]))
    },
    diffFiles: (ref) => lines(gitSafe(['diff', '--name-only', ref])),
    index: () => {
      const epoch = getIndexedAtEpoch()
      return { indexed_at: epoch, stale: isStale(epoch) }
    },
  }
}
