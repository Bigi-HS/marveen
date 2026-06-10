// Deploy-delta tracker (aios-adoption item 1, Forge-proposed).
//
// Problem (named by the fleet-deploy-verify skill itself): a dashboard restart
// activates the WHOLE develop backlog accumulated since the last deploy, not
// just the feature that was merged. There is no machine-recorded "deployed tip",
// so today the delta is reconstructed by hand from `dist/index.js` mtime and
// daily-log scraping -- fragile, and easy to under-state the surface in a GO
// request. This module records the deployed tip in store/deploy-state.json on
// each deploy and computes the precise delta (merged-but-undeployed PRs, with
// behaviour-changing ones flagged) on demand.
//
// It NEVER deploys and NEVER asks for a deploy: it is pure visibility. The
// Genesis-GO for an actual restart stays a manual, human decision.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'

export const DEPLOY_STATE_PATH = join(PROJECT_ROOT, 'store', 'deploy-state.json')

export type DeployType = 'dashboard' | 'launch-env'

export interface DeployState {
  /** The commit tip activated on the running server at the last deploy. */
  deployedSha: string
  /** ISO-8601 timestamp of the deploy. */
  deployedAt: string
  /** Which deploy shape ran: dashboard restart vs. fleet launch-env roll. */
  deployType: DeployType
  /** Optional free-text note (e.g. "PR #98 batch, Boss GO"). */
  note: string | null
}

export interface MergedPr {
  pr: number
  /** Short SHA of the merge commit. */
  sha: string
  /** Text after "Merge PR #NN: ". */
  title: string
}

export interface RiskyPr extends MergedPr {
  /** The risk keyword that matched the PR title. */
  keyword: string
}

export interface DeployDelta {
  /** Recorded deployed tip, or '' when no deploy has ever been recorded. */
  deployedSha: string
  /** Resolved head the delta is measured against (default origin/develop). */
  headSha: string
  /** Number of merged PRs that are not yet deployed. */
  ahead: number
  prs: MergedPr[]
  risky: RiskyPr[]
  /** True when there is nothing merged-but-undeployed. */
  clean: boolean
  /** True when no deployed tip is recorded yet (baseline unknown). */
  baselineUnknown: boolean
}

// Behaviour-changing surfaces the deploy-verify skill calls out explicitly:
// auth/session/cookie, rate-limiting, watchdog/launch, credential/oauth, the
// supervisor, and permission changes. A merged PR whose title mentions any of
// these rides along in a restart and changes live behaviour, so a GO request
// must surface it rather than describing only "my one feature". Tunable +
// exported so the classifier stays testable.
export const RISK_KEYWORDS: readonly string[] = [
  'auth',
  'session',
  'cookie',
  'rate-limit',
  'rate limit',
  'ratelimit',
  'watchdog',
  'launch',
  'credential',
  'oauth',
  'supervisor',
  'permission',
]

const GIT = '/usr/bin/git'

// --- pure functions (no git / no fs) -------------------------------------

/**
 * Parse `git log --oneline` output into merged-PR records. Each merge commit
 * line looks like `a8e3572 Merge PR #98: <title> (Thor+Dave)`. Lines that are
 * not "Merge PR #NN:" commits are ignored (e.g. squashed direct commits), so
 * the caller can pass a raw log without pre-filtering.
 */
export function parseMergeLines(raw: string): MergedPr[] {
  const out: MergedPr[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // <sha> Merge PR #<n>: <title>
    const m = trimmed.match(/^([0-9a-f]{7,40})\s+Merge PR #(\d+):\s*(.*)$/i)
    if (!m) continue
    out.push({ sha: m[1], pr: parseInt(m[2], 10), title: m[3].trim() })
  }
  return out
}

/**
 * Flag merged PRs whose title mentions a behaviour-changing surface. Matching
 * is case-insensitive and on whole-ish words so "auth" does not match inside an
 * unrelated longer word; the first matching keyword is reported.
 */
export function classifyRisky(prs: MergedPr[], keywords: readonly string[] = RISK_KEYWORDS): RiskyPr[] {
  const risky: RiskyPr[] = []
  for (const pr of prs) {
    const hay = pr.title.toLowerCase()
    for (const kw of keywords) {
      // Word-boundary-ish match: the keyword must not be glued to a letter on
      // either side (so "auth" hits "auth"/"reauth-token" but not "author").
      const re = new RegExp(`(^|[^a-z])${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i')
      if (re.test(hay)) {
        risky.push({ ...pr, keyword: kw })
        break
      }
    }
  }
  return risky
}

/**
 * Build a DeployDelta from a recorded deployed tip, a resolved head, and the
 * raw `git log` of merge commits between them. Pure: the caller supplies the
 * git output so this is fully unit-testable.
 */
export function buildDelta(deployedSha: string, headSha: string, rawMergeLog: string): DeployDelta {
  const baselineUnknown = !deployedSha
  const prs = parseMergeLines(rawMergeLog)
  const risky = classifyRisky(prs)
  return {
    deployedSha,
    headSha,
    ahead: prs.length,
    prs,
    risky,
    clean: !baselineUnknown && prs.length === 0,
    baselineUnknown,
  }
}

// --- git / fs IO ---------------------------------------------------------

function git(args: string[]): string {
  return execFileSync(GIT, args, { cwd: PROJECT_ROOT, timeout: 5000, encoding: 'utf-8' }).trim()
}

/** Resolve a ref (branch/sha) to a full SHA. Returns '' on failure. */
export function gitRevParse(ref: string): string {
  try {
    return git(['rev-parse', ref])
  } catch {
    return ''
  }
}

/** `git log --oneline` of merge-PR commits in deployedSha..headRef. */
export function gitMergeLog(deployedSha: string, headRef: string): string {
  if (!deployedSha) return ''
  try {
    return git(['log', '--oneline', '--grep=Merge PR', `${deployedSha}..${headRef}`])
  } catch {
    return ''
  }
}

export function readDeployState(): DeployState | null {
  try {
    if (!existsSync(DEPLOY_STATE_PATH)) return null
    const parsed = JSON.parse(readFileSync(DEPLOY_STATE_PATH, 'utf-8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.deployedSha === 'string') {
      return parsed as DeployState
    }
    return null
  } catch (err) {
    logger.warn({ err, path: DEPLOY_STATE_PATH }, 'deploy-delta: failed to read deploy state')
    return null
  }
}

export function writeDeployState(state: DeployState): void {
  writeFileSync(DEPLOY_STATE_PATH, JSON.stringify(state, null, 2) + '\n')
}

/**
 * Record a deploy: persist the activated tip to store/deploy-state.json. `sha`
 * defaults to the current PROJECT_ROOT HEAD (the tip the deploy just built).
 * `at` is injectable for testing; defaults to now.
 */
export function recordDeploy(opts: { type: DeployType; note?: string | null; sha?: string; at?: string }): DeployState {
  const sha = opts.sha || gitRevParse('HEAD')
  const state: DeployState = {
    deployedSha: sha,
    deployedAt: opts.at ?? new Date().toISOString(),
    deployType: opts.type,
    note: opts.note ?? null,
  }
  writeDeployState(state)
  return state
}

/**
 * Compute the live deploy delta: recorded deployed tip vs. `headRef`
 * (default origin/develop). Reads state + git; returns a fully-built DeployDelta.
 */
export function reportDelta(headRef = 'origin/develop'): DeployDelta {
  const state = readDeployState()
  const deployedSha = state?.deployedSha ?? ''
  const headSha = gitRevParse(headRef)
  const rawLog = gitMergeLog(deployedSha, headRef)
  return buildDelta(deployedSha, headSha, rawLog)
}

/** Human-readable one-screen summary of a delta for a GO request / report. */
export function formatDelta(delta: DeployDelta): string {
  if (delta.baselineUnknown) {
    return (
      'deploy-delta: NO recorded deployed tip (store/deploy-state.json missing). ' +
      `head=${delta.headSha.slice(0, 8)}. Run "deploy-delta record" at the next deploy to establish a baseline.`
    )
  }
  if (delta.clean) {
    return `deploy-delta: CLEAN -- deployed tip ${delta.deployedSha.slice(0, 8)} == head ${delta.headSha.slice(0, 8)}, nothing undeployed.`
  }
  const lines: string[] = []
  lines.push(
    `deploy-delta: ${delta.ahead} merged-but-undeployed PR(s) ` +
      `(${delta.deployedSha.slice(0, 8)}..${delta.headSha.slice(0, 8)})` +
      (delta.risky.length ? `, ${delta.risky.length} BEHAVIOUR-CHANGING:` : ':'),
  )
  for (const pr of delta.prs) {
    const risk = delta.risky.find((r) => r.pr === pr.pr)
    lines.push(`  - #${pr.pr} ${pr.title}${risk ? `  [RISK: ${risk.keyword}]` : ''}`)
  }
  return lines.join('\n')
}
