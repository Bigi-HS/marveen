// Card 66cf63ed -- intake risk-classifier -> auto gate req-matrix.
//
// Proves the four build-obligations Chad attached to his security PASS:
//   (a) PATH-SPLIT VERBATIM-EQUIVALENCE: the security<->credential split covers
//       EXACTLY the path set of today's isSecuritySensitivePath (no path drops
//       out of chad-required) -- by construction AND by test.
//   (b) runGateCheck DB-INDEPENDENCE: a stored gate_pr_risk row is NEVER an input
//       to enforcement; the check-time re-derivation over the live head is the
//       sole source.
//   (c) DOCUMENTED RESIDUALS: `rm -fr` / `rm -r -f` variants are not matched by
//       the destructive regex (accepted, trusted-author); the credential tag is
//       PATH-based, not content-based.
//   (d) POST-RECUSAL ADDITIVITY: recusal(new) ⊇ recusal(old) across the
//       {legacy-sec, content-only, both, neither} × {author none/thor/dave/chad}
//       matrix.
//
// See store/specs/v2-gate-risk-matrix.md.

import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  isSecuritySensitivePath,
  requiredReviewers,
  applyAuthorRecusal,
  getQaSeat,
  runGateCheck,
  pathTags,
  contentTags,
  classifyDiffRisk,
  requiredSeatsForRisk,
  riskForPrInfo,
  type PrFileDiff,
  type DiffRisk,
  type GateCheckDeps,
  type GithubPrInfo,
  type Reviewer,
} from '../web/gate-check.js'
import { migrateGateTables, insertPrRisk, readLatestPrRisk, countChadByContentOnly } from '../web/gate-db.js'

const SHA_A = 'a'.repeat(40)

function fd(filename: string, addedLines: string[] = [], patchPresent = true): PrFileDiff {
  return { filename, addedLines, patchPresent }
}

// ---------------------------------------------------------------------------
// (a) PATH-SPLIT VERBATIM-EQUIVALENCE
// ---------------------------------------------------------------------------

// A representative path corpus: every branch of isSecuritySensitivePath plus
// ordinary files and the #986 destructive-but-not-security-path file.
const SECURITY_PATHS = [
  'scripts/hooks/guardrail-ask-first.py',
  'scripts/autopilot/classify.py',
  'src/mcp/server.ts',
  'src/analytics/tokens.ts',
  'src/analytics/youtube.ts',
  'src/aidefence-guard.ts',
  'src/prompt-safety.ts',
  'src/team-trust.ts',
  'src/web/gate-check.ts',
  'src/web/gate-db.ts',
  'src/web/github-pr.ts',
  'src/web/github-merge.ts',
  'src/web/routes/gate.ts',
  'src/web/routes/github.ts',
  'seed-skills/fleet-pr-merge-gate/SKILL.md',
  'src/web/dashboard-auth.ts',
  'src/web/agent-identity-binding.ts',
  'src/web/agent-token-registry.ts',
  'src/web/routes/admin.ts',
  'src/web/routes/codetree.ts',
  'src/web/codetree-impact-io.ts',
  'templates/profiles/default.json',
  'templates/settings.json.template',
  'src/web/public-paths.ts',
  'seed-config/autonomy-config.json',
  'agents/claudia/.env',
  'agents/claudia/.env.local',
  'src/web/oauth-helper.ts',
  'src/credential-core.ts',
  'scripts/guardrail-check.sh',
  'store/token-expiry.ts',
  'src/auth/token-refresh.ts',
  'src/secret/token.ts',
]
const ORDINARY_PATHS = [
  'src/db.ts',
  'src/web/kanban.ts',
  'src/web/tokenizer.ts',
  'scripts/sandbox-down.sh', // the #986 file -- a scripts/ path NOT under hooks/autopilot
  'README.md',
  'src/web/routes/analytics.ts', // deliberately NOT a security path (pure read aggregation)
  '',
]

describe('(a) path-split verbatim-equivalence with isSecuritySensitivePath', () => {
  it('pathTags fires IFF isSecuritySensitivePath -- no path drops out of chad', () => {
    for (const f of [...SECURITY_PATHS, ...ORDINARY_PATHS]) {
      const tags = pathTags(f)
      expect(tags.length > 0).toBe(isSecuritySensitivePath(f))
    }
  })

  it('every path tag is security|credential and always requires chad', () => {
    for (const f of SECURITY_PATHS) {
      const tags = pathTags(f)
      expect(tags.length).toBeGreaterThan(0)
      for (const t of tags) expect(['security', 'credential']).toContain(t)
      // the derived seat-set for a path-tagged diff must include chad
      const seats = requiredSeatsForRisk({ tags, level: 'high', unknown: false })
      expect(seats).toContain('chad')
    }
  })

  it('src/analytics/** stays under the security tag (zero churn, NoA review pt 3)', () => {
    expect(pathTags('src/analytics/tokens.ts')).toEqual(['security'])
    expect(pathTags('src/analytics/youtube.ts')).toEqual(['security'])
  })

  it('ordinary files carry no path tag', () => {
    for (const f of ORDINARY_PATHS) expect(pathTags(f)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// content tags: per-tag positive + negative (non-vacuous)
// ---------------------------------------------------------------------------

describe('content tags -- destructive', () => {
  it('matches rm -rf (the #986 class), DROP TABLE, --force, --hard, rmtree', () => {
    expect(contentTags(['  rm -rf "$dir"'])).toContain('destructive')
    expect(contentTags(['DROP TABLE users;'])).toContain('destructive')
    expect(contentTags(['git push --force origin main'])).toContain('destructive')
    expect(contentTags(['git reset --hard HEAD~3'])).toContain('destructive')
    expect(contentTags(['shutil.rmtree(path)'])).toContain('destructive')
  })

  it('does NOT tag ordinary added lines', () => {
    expect(contentTags(['const x = 1', 'return items.map(f => f.id)'])).not.toContain('destructive')
    expect(contentTags(['// remove the old entry from the list'])).not.toContain('destructive')
  })

  // (c) DOCUMENTED RESIDUAL: reversed / split flag clusters are NOT covered.
  it('(c) accepted residual: rm -fr and rm -r -f are NOT matched (trusted-author)', () => {
    expect(contentTags(['rm -fr /tmp/x'])).not.toContain('destructive')
    expect(contentTags(['rm -r -f /tmp/x'])).not.toContain('destructive')
  })
})

describe('content tags -- input-parsing (narrowed, NoA review pt 2)', () => {
  it('matches inherently-unsafe deserializers', () => {
    expect(contentTags(['data = yaml.load(raw)'])).toContain('input-parsing')
    expect(contentTags(['obj = pickle.loads(blob)'])).toContain('input-parsing')
    expect(contentTags(['parser = XMLParser(resolve_entities=True)'])).toContain('input-parsing')
  })

  it('matches a parse co-located with a request/network source token', () => {
    expect(contentTags(['const p = JSON.parse(req.body)'])).toContain('input-parsing')
    expect(contentTags(['body = JSON.parse(payload)'])).toContain('input-parsing')
  })

  it('does NOT tag plain JSON.parse of internal/config data', () => {
    expect(contentTags(['const cfg = JSON.parse(fileContents)'])).not.toContain('input-parsing')
    expect(contentTags(['const data = JSON.parse(cachedString)'])).not.toContain('input-parsing')
  })

  it('does NOT tag yaml.load with a Safe loader', () => {
    expect(contentTags(['data = yaml.load(raw, Loader=yaml.SafeLoader)'])).not.toContain('input-parsing')
  })
})

describe('content tags -- exec', () => {
  it('matches child_process, eval, Function, os.system, subprocess', () => {
    expect(contentTags(["import { execFileSync } from 'node:child_process'"])).toContain('exec')
    expect(contentTags(['const r = eval(userExpr)'])).toContain('exec')
    expect(contentTags(['const f = new Function("return 1")'])).toContain('exec')
    expect(contentTags(['os.system(cmd)'])).toContain('exec')
    expect(contentTags(['subprocess.run(args)'])).toContain('exec')
  })

  it('does NOT tag ordinary code', () => {
    expect(contentTags(['const evaluation = computeScore(x)'])).not.toContain('exec')
  })
})

// ---------------------------------------------------------------------------
// classifyDiffRisk: level, unknown, determinism
// ---------------------------------------------------------------------------

describe('classifyDiffRisk -- level (max-wins)', () => {
  it('high when security|credential|destructive present', () => {
    expect(classifyDiffRisk([fd('src/mcp/server.ts')]).level).toBe('high')
    expect(classifyDiffRisk([fd('scripts/x.sh', ['rm -rf /tmp/x'])]).level).toBe('high')
  })
  it('medium when only input-parsing|exec present', () => {
    expect(classifyDiffRisk([fd('src/p.ts', ['JSON.parse(req.body)'])]).level).toBe('medium')
    expect(classifyDiffRisk([fd('src/e.ts', ['eval(x)'])]).level).toBe('medium')
  })
  it('low when no tags', () => {
    expect(classifyDiffRisk([fd('src/db.ts', ['const x = 1'])]).level).toBe('low')
  })
})

describe('classifyDiffRisk -- unknown (fail-closed, §6)', () => {
  it('unknown when any file has no patch (binary/omitted/oversized)', () => {
    const r = classifyDiffRisk([fd('assets/logo.png', [], false)])
    expect(r.unknown).toBe(true)
    expect(requiredSeatsForRisk(r)).toContain('chad')
  })
  it('unknown when the file list is empty (fail-closed)', () => {
    const r = classifyDiffRisk([])
    expect(r.unknown).toBe(true)
    expect(requiredSeatsForRisk(r)).toContain('chad')
  })
})

describe('classifyDiffRisk -- determinism (script-writes-it invariant)', () => {
  it('same input twice -> deep-equal matrix', () => {
    const files = [fd('src/mcp/server.ts'), fd('scripts/x.sh', ['rm -rf /tmp/x', 'JSON.parse(req.body)'])]
    expect(classifyDiffRisk(files)).toEqual(classifyDiffRisk(files))
  })
  it('tags are sorted and de-duplicated', () => {
    const r = classifyDiffRisk([fd('src/a.ts', ['rm -rf x']), fd('src/b.ts', ['rm -rf y'])])
    expect(r.tags).toEqual([...r.tags].sort())
    expect(new Set(r.tags).size).toBe(r.tags.length)
  })
})

// ---------------------------------------------------------------------------
// requiredSeatsForRisk + additivity
// ---------------------------------------------------------------------------

const QA = getQaSeat()

function superset(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a)
  return b.every((x) => sa.has(x))
}

function oldRequired(filenames: string[]): Reviewer[] {
  return requiredReviewers(filenames.some(isSecuritySensitivePath))
}
function newRequired(files: PrFileDiff[]): Reviewer[] {
  return requiredSeatsForRisk(classifyDiffRisk(files))
}

// The four canonical diff shapes.
const SHAPES: Record<string, PrFileDiff[]> = {
  'legacy-sec': [fd('src/mcp/server.ts', ['const x = 1'])],
  'content-only': [fd('scripts/sandbox-down.sh', ['rm -rf "$SANDBOX_DIR"'])],
  both: [fd('src/web/gate-check.ts', ['rm -rf x'])],
  neither: [fd('src/db.ts', ['const x = 1'])],
}

describe('requiredSeatsForRisk -- floor and chad trigger', () => {
  it('floor is [qa, dave] with no tags', () => {
    expect(newRequired(SHAPES.neither)).toEqual([QA, 'dave'])
  })
  it('adds chad for any tag or unknown', () => {
    expect(newRequired(SHAPES['legacy-sec'])).toContain('chad')
    expect(newRequired(SHAPES['content-only'])).toContain('chad')
    expect(newRequired(SHAPES.both)).toContain('chad')
  })
})

describe('additive PRE-recusal: new ⊇ old for every shape', () => {
  for (const [name, files] of Object.entries(SHAPES)) {
    it(`${name}: requiredSeatsForRisk(new) ⊇ requiredReviewers(old)`, () => {
      const oldR = oldRequired(files.map((f) => f.filename))
      const newR = newRequired(files)
      expect(superset(newR, oldR)).toBe(true)
    })
  }
  it('content-only closes the #986 gap: old=[qa,dave], new adds chad', () => {
    const files = SHAPES['content-only']
    expect(oldRequired(files.map((f) => f.filename))).toEqual([QA, 'dave'])
    expect(newRequired(files)).toContain('chad')
  })
})

// (d) POST-RECUSAL ADDITIVITY MATRIX
describe('(d) additive POST-recusal: recusal(new) ⊇ recusal(old) for every cell', () => {
  const authors: (string | null)[] = [null, 'thor', 'dave', 'chad']
  for (const [name, files] of Object.entries(SHAPES)) {
    for (const author of authors) {
      it(`shape=${name} author=${author ?? 'none'}`, () => {
        const oldR = applyAuthorRecusal(oldRequired(files.map((f) => f.filename)), author).required
        const newR = applyAuthorRecusal(newRequired(files), author).required
        expect(superset(newR, oldR)).toBe(true)
        // invariant: never below 2 required reviewers
        expect(new Set(newR).size).toBeGreaterThanOrEqual(2)
      })
    }
  }
})

// ---------------------------------------------------------------------------
// riskForPrInfo: legacy fallback (back-compat) vs fileDiffs mode
// ---------------------------------------------------------------------------

describe('riskForPrInfo -- legacy files-only fallback stays byte-identical to old', () => {
  it('no fileDiffs: path-only, never a content tag, never unknown', () => {
    const info: GithubPrInfo = { headSha: SHA_A, files: ['src/db.ts', 'src/mcp/server.ts'] }
    const risk = riskForPrInfo(info)
    expect(risk.unknown).toBe(false)
    expect(risk.tags).toEqual(['security']) // from src/mcp path, no content inspected
    expect(requiredSeatsForRisk(risk)).toEqual([QA, 'dave', 'chad'])
  })
  it('no fileDiffs + ordinary files: [qa, dave] exactly as before', () => {
    const info: GithubPrInfo = { headSha: SHA_A, files: ['src/db.ts', 'README.md'] }
    expect(requiredSeatsForRisk(riskForPrInfo(info))).toEqual([QA, 'dave'])
  })
  it('fileDiffs mode: content tags activate', () => {
    const info: GithubPrInfo = {
      headSha: SHA_A,
      files: ['scripts/sandbox-down.sh'],
      fileDiffs: [fd('scripts/sandbox-down.sh', ['rm -rf "$DIR"'])],
    }
    const risk = riskForPrInfo(info)
    expect(risk.tags).toContain('destructive')
    expect(requiredSeatsForRisk(risk)).toContain('chad')
  })
})

// ---------------------------------------------------------------------------
// (b) runGateCheck DB-INDEPENDENCE
// ---------------------------------------------------------------------------

describe('(b) runGateCheck ignores any stored gate_pr_risk row; live head is the only source', () => {
  it('a stored low/no-chad intake row does NOT suppress chad for a live destructive diff', async () => {
    const db = new Database(':memory:')
    migrateGateTables(db)
    // Adversarial stored intake row: claims low risk, no tags.
    insertPrRisk(
      db,
      { pr_number: 555, head_sha: SHA_A, risk_tags: '', risk_level: 'low', risk_unknown: 0, recorded_by: 'attacker' },
      1000,
    )
    // Live diff has a destructive added line -> chad MUST be required regardless.
    const deps: GateCheckDeps = {
      fetchPr: async () => ({
        headSha: SHA_A,
        files: ['scripts/sandbox-down.sh'],
        fileDiffs: [fd('scripts/sandbox-down.sh', ['rm -rf "$DIR"'])],
      }),
      readApprovals: () => [],
      hasActiveOverride: () => false,
    }
    const result = await runGateCheck(555, deps)
    expect(result.required).toContain('chad')
    expect(result.risk_tags).toContain('destructive')
    expect(result.pass).toBe(false) // chad missing
    db.close()
  })

  it('exposes the audit surface (risk_tags/level/unknown) on the result', async () => {
    const deps: GateCheckDeps = {
      fetchPr: async () => ({
        headSha: SHA_A,
        files: ['src/mcp/server.ts'],
        fileDiffs: [fd('src/mcp/server.ts', ['const x = 1'])],
      }),
      readApprovals: () => [],
      hasActiveOverride: () => false,
    }
    const result = await runGateCheck(1, deps)
    expect(result.risk_level).toBe('high')
    expect(result.risk_tags).toContain('security')
    expect(result.risk_unknown).toBe(false)
  })

  it('unknown content (binary/omitted patch) forces chad at check-time', async () => {
    const deps: GateCheckDeps = {
      fetchPr: async () => ({
        headSha: SHA_A,
        files: ['assets/logo.png'],
        fileDiffs: [fd('assets/logo.png', [], false)],
      }),
      readApprovals: () => [],
      hasActiveOverride: () => false,
    }
    const result = await runGateCheck(2, deps)
    expect(result.risk_unknown).toBe(true)
    expect(result.required).toContain('chad')
  })
})

// ---------------------------------------------------------------------------
// gate_pr_risk persistence + §10 FP/coverage metric
// ---------------------------------------------------------------------------

describe('gate_pr_risk persistence + §10 chad-by-content metric', () => {
  afterEach(() => {})

  it('insert + read latest risk row', () => {
    const db = new Database(':memory:')
    migrateGateTables(db)
    insertPrRisk(
      db,
      { pr_number: 10, head_sha: SHA_A, risk_tags: 'destructive', risk_level: 'high', risk_unknown: 0, recorded_by: 'dave' },
      100,
    )
    const row = readLatestPrRisk(db, 10)
    expect(row?.risk_tags).toBe('destructive')
    expect(row?.risk_level).toBe('high')
    db.close()
  })

  it('counts chad-required-SOLELY-by-content-tag PRs since a cutoff', () => {
    const db = new Database(':memory:')
    migrateGateTables(db)
    // content-only (destructive) -> counted
    insertPrRisk(db, { pr_number: 1, head_sha: SHA_A, risk_tags: 'destructive', risk_level: 'high', risk_unknown: 0, recorded_by: 'd' }, 5000)
    // input-parsing only -> counted
    insertPrRisk(db, { pr_number: 2, head_sha: SHA_A, risk_tags: 'input-parsing', risk_level: 'medium', risk_unknown: 0, recorded_by: 'd' }, 5000)
    // security path present -> NOT counted (legacy security, not content-only)
    insertPrRisk(db, { pr_number: 3, head_sha: SHA_A, risk_tags: 'destructive,security', risk_level: 'high', risk_unknown: 0, recorded_by: 'd' }, 5000)
    // no tags -> NOT counted
    insertPrRisk(db, { pr_number: 4, head_sha: SHA_A, risk_tags: '', risk_level: 'low', risk_unknown: 0, recorded_by: 'd' }, 5000)
    // before cutoff -> NOT counted
    insertPrRisk(db, { pr_number: 5, head_sha: SHA_A, risk_tags: 'exec', risk_level: 'medium', risk_unknown: 0, recorded_by: 'd' }, 100)
    expect(countChadByContentOnly(db, 1000)).toBe(2)
    db.close()
  })
})
