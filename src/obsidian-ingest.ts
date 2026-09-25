import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// ─── Public types ────────────────────────────────────────────────────────────

export interface FrontMatter {
  title?: string
  tags?: string[]
  date?: string
  url?: string
  generated?: boolean
  [key: string]: unknown
}

export interface ParsedNote {
  relativePath: string
  frontmatter: FrontMatter
  body: string
}

export interface IngestConfig {
  vaultPath: string
  include: string[]       // folder/glob patterns; empty = no-op (0 files)
  exclude?: string[]      // extra excludes on top of DENYLIST_PATHS
  tier: string            // 'warm' default for personal reference notes
  agentId: string         // 'marveen' default
  dryRun?: boolean
}

export interface MemoriaEntry {
  content: string
  keywords: string
  tier: string
  agentId: string
}

export interface MemoriaClient {
  search(sourceMarker: string): Promise<{ id: number; contentHash: string } | null>
  create(entry: MemoriaEntry): Promise<{ id: number }>
  update(id: number, entry: MemoriaEntry): Promise<void>
}

export interface IngestResult {
  processed: number
  created: number
  updated: number
  skippedGenerated: number
  skippedDenylist: number
  skippedNotInAllowlist: number
  skippedUnchanged: number
  dryRunListed: number
}

// ─── Constants ───────────────────────────────────────────────────────────────

// Hard-coded denylist: fleet-generated subtrees that must never be re-ingested.
// These are written by scripts/obsidian-vault-sync.py (memoria→vault direction).
// Ingesting them back would create a feedback loop.
export const DENYLIST_PATHS: string[] = [
  'Memories/',
  'Daily Log/',
  'Views/',
  'Home.md',
  'Welcome.md',
]

// ─── parseFrontmatter ────────────────────────────────────────────────────────

/**
 * Parses YAML frontmatter from Obsidian .md file content.
 * Supports simple scalar values, arrays (bracket and dash syntax), and booleans.
 * Zero external dependencies.
 */
export function parseFrontmatter(content: string): { frontmatter: FrontMatter; body: string } {
  const fm: FrontMatter = {}

  if (!content.startsWith('---')) {
    return { frontmatter: fm, body: content }
  }

  const end = content.indexOf('\n---', 3)
  if (end === -1) {
    return { frontmatter: fm, body: content }
  }

  const fmBlock = content.slice(4, end).trim()
  const body = content.slice(end + 4).trimStart()

  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const rawVal = line.slice(colonIdx + 1).trim()
    if (!key) continue

    // Boolean
    if (rawVal === 'true') { fm[key] = true; continue }
    if (rawVal === 'false') { fm[key] = false; continue }

    // Bracket array: [a, b, c]
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      fm[key] = rawVal
        .slice(1, -1)
        .split(',')
        .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
      continue
    }

    // Scalar (strip optional quotes)
    if (rawVal !== '') {
      fm[key] = rawVal.replace(/^['"]|['"]$/g, '')
    }
  }

  return { frontmatter: fm, body }
}

// ─── shouldSkip ──────────────────────────────────────────────────────────────

/**
 * Returns true if a file should be skipped.
 * Priority order: generated flag > denylist > allowlist.
 */
export function shouldSkip(
  relativePath: string,
  frontmatter: FrontMatter,
  include: string[],
  extraExclude: string[] = [],
): boolean {
  // 1. Empty allowlist = no-op
  if (include.length === 0) return true

  // 2. generated:true frontmatter (sync-script output guard)
  if (frontmatter.generated === true) return true

  // 3. Denylist paths (hard-coded safety net against feedback loop)
  const allDenied = [...DENYLIST_PATHS, ...extraExclude]
  for (const denied of allDenied) {
    if (denied.endsWith('/')) {
      if (relativePath.startsWith(denied) || relativePath.includes(`/${denied.slice(0, -1)}/`)) {
        return true
      }
    } else {
      if (relativePath === denied) return true
    }
  }

  // 4. Allowlist: file must match at least one include pattern
  for (const pattern of include) {
    if (pattern.endsWith('/')) {
      // Folder prefix match
      if (relativePath.startsWith(pattern)) return false
    } else if (pattern.includes('*')) {
      // Simple glob: only support *.ext at root level
      const ext = pattern.slice(pattern.lastIndexOf('*') + 1)
      if (!pattern.includes('/') && relativePath.indexOf('/') === -1 && relativePath.endsWith(ext)) {
        return false
      }
      // Glob with path prefix: Research/**/*.md
      const prefix = pattern.slice(0, pattern.indexOf('*'))
      const suffix = pattern.slice(pattern.lastIndexOf('*') + 1)
      if (prefix && relativePath.startsWith(prefix) && relativePath.endsWith(suffix)) return false
    } else {
      // Exact match
      if (relativePath === pattern) return false
    }
  }

  return true
}

// ─── buildMemoriaContent ─────────────────────────────────────────────────────

/**
 * Builds the memoria entry content string from a parsed note.
 * Embeds [obsidian-source: {relativePath}] marker for dedup lookups.
 */
export function buildMemoriaContent(note: ParsedNote): string {
  const { relativePath, frontmatter, body } = note
  const parts: string[] = []

  // Title + URL header
  if (frontmatter.title && frontmatter.url) {
    parts.push(`[${frontmatter.title}](${frontmatter.url})`)
  } else if (frontmatter.title) {
    parts.push(frontmatter.title)
  }

  if (frontmatter.date) {
    parts.push(`Date: ${frontmatter.date}`)
  }

  parts.push(body.trim())
  parts.push(`[obsidian-source: ${relativePath}]`)

  return parts.filter(Boolean).join('\n\n')
}

// ─── computeHash ─────────────────────────────────────────────────────────────

export function computeHash(content: string): string {
  return createHash('sha1').update(content, 'utf8').digest('hex').slice(0, 16)
}

// ─── buildKeywords ───────────────────────────────────────────────────────────

function buildKeywords(frontmatter: FrontMatter): string {
  const tags = frontmatter.tags
  if (Array.isArray(tags) && tags.length > 0) {
    return tags.join(', ')
  }
  return ''
}

// ─── scanVault ───────────────────────────────────────────────────────────────

function scanVault(vaultPath: string): string[] {
  const results: string[] = []

  function walk(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const full = join(dir, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
      } else if (entry.endsWith('.md')) {
        results.push(full)
      }
    }
  }

  walk(vaultPath)
  return results
}

// ─── ingest ──────────────────────────────────────────────────────────────────

export async function ingest(config: IngestConfig, client: MemoriaClient): Promise<IngestResult> {
  const { vaultPath, include, exclude = [], tier, agentId, dryRun = false } = config

  const result: IngestResult = {
    processed: 0,
    created: 0,
    updated: 0,
    skippedGenerated: 0,
    skippedDenylist: 0,
    skippedNotInAllowlist: 0,
    skippedUnchanged: 0,
    dryRunListed: 0,
  }

  if (include.length === 0) return result

  const allFiles = scanVault(vaultPath)

  for (const absPath of allFiles) {
    const rel = relative(vaultPath, absPath).replace(/\\/g, '/')

    const rawContent = readFileSync(absPath, 'utf8')
    const { frontmatter, body } = parseFrontmatter(rawContent)

    // Classify skip reason for reporting
    if (frontmatter.generated === true) {
      result.skippedGenerated++
      continue
    }

    const isDenied = DENYLIST_PATHS.some(d =>
      d.endsWith('/') ? rel.startsWith(d) : rel === d
    ) || exclude.some(d =>
      d.endsWith('/') ? rel.startsWith(d) : rel === d
    )
    if (isDenied) {
      result.skippedDenylist++
      continue
    }

    const isAllowed = include.some(pattern => {
      if (pattern.endsWith('/')) return rel.startsWith(pattern)
      if (pattern.includes('*')) {
        const prefix = pattern.slice(0, pattern.indexOf('*'))
        const suffix = pattern.slice(pattern.lastIndexOf('*') + 1)
        if (prefix) return rel.startsWith(prefix) && rel.endsWith(suffix)
        return !pattern.includes('/') && rel.indexOf('/') === -1 && rel.endsWith(suffix)
      }
      return rel === pattern
    })
    if (!isAllowed) {
      result.skippedNotInAllowlist++
      continue
    }

    const note: ParsedNote = { relativePath: rel, frontmatter, body }
    const content = buildMemoriaContent(note)
    const contentHash = computeHash(content)
    const keywords = buildKeywords(frontmatter)

    if (dryRun) {
      result.dryRunListed++
      continue
    }

    result.processed++

    const existing = await client.search(rel)
    if (existing) {
      if (existing.contentHash === contentHash) {
        result.skippedUnchanged++
        result.processed-- // not actually written
        continue
      }
      await client.update(existing.id, { content, keywords, tier, agentId })
      result.updated++
    } else {
      await client.create({ content, keywords, tier, agentId })
      result.created++
    }
  }

  return result
}
