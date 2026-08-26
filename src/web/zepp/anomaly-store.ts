// Persistent cross-field anomaly flag store (WELL-028 G3 / card 44783957 P0).
//
// The plausibility guard (health-plausibility.ts) DETECTS a suspect snapshot -- e.g. the
// BUG-2 cross-field anomaly where steps are large but distance is ~0 -- but the ingest path
// historically only LOGGED it (onPlausibility = logger.warn). A log line is a silent
// observer: nothing surfaces it to a monitor, so a real regression can reach a Boss-facing
// number unseen. This store persists the suspect signal as a queryable health flag, one file
// per day under store/zepp/anomalies/, so a monitor/endpoint can read it.
//
// Self-correcting, mirroring the step-estimate remediation: each push re-records, so a later
// clean push (no suspect rule) RESOLVES an open flag rather than leaving a stale alarm. The
// resolved record is kept for audit (detectedAt..resolvedAt); a day that goes suspect again
// after resolving starts a fresh episode.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One plausibility violation carried into a flag (mirrors PlausibilityViolation). */
export interface AnomalyRule {
  rule: string
  severity: 'suspect' | 'warning'
  message: string
}

/** A persisted cross-field anomaly flag for one day. */
export interface AnomalyFlag {
  date: string
  /** ISO of the first detection of the current open episode. */
  detectedAt: string
  /** ISO of the most recent record() call that touched this flag. */
  updatedAt: string
  /** True once a clean push cleared the anomaly; the record is kept for audit. */
  resolved: boolean
  /** ISO when the flag was resolved (present only when resolved). */
  resolvedAt?: string
  /** The suspect rules at the last open record (empty once resolved). */
  rules: AnomalyRule[]
}

const FILE_PREFIX = 'anomaly-'
const FILE_SUFFIX = '.json'

// Strict YYYY-MM-DD: the date is the only user-influenced part of the on-disk filename, so it
// must never contain path separators or `..` segments that could escape the store root.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidDate(date: string): boolean {
  return typeof date === 'string' && DATE_RE.test(date)
}

function fileName(date: string): string {
  return `${FILE_PREFIX}${date}${FILE_SUFFIX}`
}

function parseDate(name: string): string | null {
  if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) return null
  return name.slice(FILE_PREFIX.length, -FILE_SUFFIX.length)
}

export class ZeppAnomalyStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }

  /**
   * Record the current suspect rules for a day. With suspect rules present, an open flag is
   * upserted (keeping the original detectedAt while it stays open). With no suspect rules, an
   * open flag is resolved; an absent or already-resolved flag is left untouched (returns the
   * existing flag or null -- no empty flag is fabricated). Returns the resulting flag, or null
   * when nothing was written.
   */
  record(date: string, rules: AnomalyRule[], nowIso: string): AnomalyFlag | null {
    if (!isValidDate(date)) {
      throw new Error(`invalid anomaly date: ${JSON.stringify(date)} (expected YYYY-MM-DD)`)
    }
    const existing = this.get(date)

    if (rules.length > 0) {
      // Suspect present -> open (or keep open). Preserve detectedAt while continuously open;
      // a previously-resolved day starts a fresh episode.
      const detectedAt = existing && !existing.resolved ? existing.detectedAt : nowIso
      const flag: AnomalyFlag = { date, detectedAt, updatedAt: nowIso, resolved: false, rules }
      this.writeFlag(flag)
      return flag
    }

    // No suspect rules. Only act if there is an OPEN flag to resolve.
    if (existing && !existing.resolved) {
      const resolved: AnomalyFlag = {
        ...existing,
        updatedAt: nowIso,
        resolved: true,
        resolvedAt: nowIso,
        rules: [],
      }
      this.writeFlag(resolved)
      return resolved
    }
    return existing // already resolved, or nothing here -> no change
  }

  get(date: string): AnomalyFlag | null {
    if (!isValidDate(date)) return null
    const path = join(this.root, fileName(date))
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as AnomalyFlag
    } catch {
      return null
    }
  }

  /** All flags (open + resolved), sorted by date. Corrupt files are skipped. */
  list(): AnomalyFlag[] {
    let names: string[]
    try {
      names = readdirSync(this.root)
    } catch {
      return []
    }
    return names
      .map(parseDate)
      .filter((d): d is string => d !== null)
      .sort()
      .map((d) => this.get(d))
      .filter((f): f is AnomalyFlag => f !== null)
  }

  /** Open (unresolved) flags only, sorted by date -- the actionable set for a monitor. */
  listOpen(): AnomalyFlag[] {
    return this.list().filter((f) => !f.resolved)
  }

  private writeFlag(flag: AnomalyFlag): void {
    const path = join(this.root, fileName(flag.date))
    writeFileSync(path, JSON.stringify(flag, null, 2), { mode: 0o600 })
  }
}

// Default store pointing at store/zepp/anomalies/ relative to MARVEEN_ROOT.
const PROJECT_ROOT = process.env.MARVEEN_ROOT ?? process.cwd()
export const defaultZeppAnomalyStore = new ZeppAnomalyStore(join(PROJECT_ROOT, 'store', 'zepp', 'anomalies'))
