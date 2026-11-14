// Card c81ce4bf -- the levelForTags single-source extraction (chad obligations).
//   (a) VERBATIM-EQUIVALENCE: classifyDiffRisk output is unchanged by the pure
//       refactor that moved the tag->level rule into levelForTags.
//   (b) NO-TRIAGE-IMPORT: gate-check.ts (the enforcement module) never imports
//       triage state -- the dependency is one-way (intake-triage -> gate-check).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  RISK_TAGS,
  type Tag,
  type RiskLevel,
  levelForTags,
  classifyDiffRisk,
  type PrFileDiff,
} from '../web/gate-check.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..', 'web')

// The ORIGINAL inline rule, restated INDEPENDENTLY here (the code that lived in
// classifyDiffRisk before the extraction): high if any high-tag, else medium if
// any medium-tag, else low. levelForTags must equal this for every tag subset.
const HIGH: readonly Tag[] = ['security', 'credential', 'destructive']
const MEDIUM: readonly Tag[] = ['input-parsing', 'exec']
function originalInlineRule(tags: readonly Tag[]): RiskLevel {
  if (tags.some((t) => HIGH.includes(t))) return 'high'
  if (tags.some((t) => MEDIUM.includes(t))) return 'medium'
  return 'low'
}

// Enumerate all 2^5 subsets of the tag set.
function allTagSubsets(): Tag[][] {
  const tags = [...RISK_TAGS]
  const out: Tag[][] = []
  for (let mask = 0; mask < 1 << tags.length; mask++) {
    out.push(tags.filter((_, i) => mask & (1 << i)))
  }
  return out
}

describe('levelForTags extraction -- verbatim equivalence (chad obligation a)', () => {
  it('matches the original inline rule for EVERY tag subset (2^5)', () => {
    const subsets = allTagSubsets()
    expect(subsets).toHaveLength(32)
    for (const subset of subsets) {
      expect(levelForTags(subset)).toBe(originalInlineRule(subset))
    }
  })

  it('classifyDiffRisk still derives the same level end-to-end after extraction', () => {
    // security path -> high
    const sec: PrFileDiff[] = [{ filename: 'src/web/gate-check.ts', addedLines: [], patchPresent: true }]
    expect(classifyDiffRisk(sec).level).toBe('high')

    // destructive content -> high
    const destr: PrFileDiff[] = [{ filename: 'scripts/x.sh', addedLines: ['rm -rf /tmp/foo'], patchPresent: true }]
    expect(classifyDiffRisk(destr).level).toBe('high')

    // exec content only -> medium
    const execOnly: PrFileDiff[] = [{ filename: 'src/util.ts', addedLines: ['const x = child_process'], patchPresent: true }]
    expect(classifyDiffRisk(execOnly).level).toBe('medium')

    // ordinary file, no signal -> low
    const low: PrFileDiff[] = [{ filename: 'README.md', addedLines: ['hello world'], patchPresent: true }]
    expect(classifyDiffRisk(low).level).toBe('low')
  })

  it('classifyDiffRisk.level always equals levelForTags(its own tags) -- internal consistency', () => {
    const corpus: PrFileDiff[][] = [
      [{ filename: 'src/web/dashboard-auth.ts', addedLines: [], patchPresent: true }],
      [{ filename: 'scripts/x.sh', addedLines: ['DROP TABLE users'], patchPresent: true }],
      [{ filename: 'src/a.ts', addedLines: ['eval(code)'], patchPresent: true }],
      [{ filename: 'src/a.ts', addedLines: ['JSON.parse(req.body)'], patchPresent: true }],
      [{ filename: 'docs/readme.md', addedLines: ['nothing risky'], patchPresent: true }],
    ]
    for (const files of corpus) {
      const risk = classifyDiffRisk(files)
      expect(risk.level).toBe(levelForTags(risk.tags))
    }
  })
})

describe('one-way dependency -- gate-check never reads triage (chad obligation b)', () => {
  const gateSrc = readFileSync(join(SRC, 'gate-check.ts'), 'utf8')
  const triageSrc = readFileSync(join(SRC, 'intake-triage.ts'), 'utf8')

  it('gate-check.ts does NOT import from intake-triage (no reverse dependency)', () => {
    expect(gateSrc).not.toMatch(/import[\s\S]*?from\s+['"][^'"]*intake-triage/)
  })

  it('intake-triage.ts imports FROM gate-check (the dependency is one-way)', () => {
    expect(triageSrc).toMatch(/from\s+['"]\.\/gate-check(\.js)?['"]/)
  })

  it('GateCheckDeps -- the enforcement input surface -- carries no triage reader', () => {
    // Precise: only the interface BODY (an explanatory comment elsewhere in the
    // module may legitimately reference intake-triage to document the boundary;
    // what matters is that the injected dependency set has no triage reader).
    const m = gateSrc.match(/export interface GateCheckDeps \{[\s\S]*?\n\}/)
    expect(m).toBeTruthy()
    expect(m![0].toLowerCase()).not.toContain('triage')
  })
})
