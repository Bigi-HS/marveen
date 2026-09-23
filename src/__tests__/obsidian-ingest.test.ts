import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseFrontmatter,
  shouldSkip,
  buildMemoriaContent,
  computeHash,
  ingest,
  type IngestConfig,
  type MemoriaClient,
  type ParsedNote,
  DENYLIST_PATHS,
} from '../obsidian-ingest.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const NOTE_WITH_FULL_FM = `---
title: Research on Agents
tags: [agents, ai, claude]
date: 2026-09-20
url: https://example.com/agents
---
# Body

Some research notes here.
`

const NOTE_GENERATED = `---
title: marveen (Cold)
generated: true
type: memory
agent: marveen
tier: cold
---
Generated content.
`

const NOTE_NO_FRONTMATTER = `# Plain note

Just body content with no frontmatter.
`

const NOTE_PARTIAL_FM = `---
title: Partial Note
---
Body only with title.
`

// ─── parseFrontmatter ─────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('parses full frontmatter', () => {
    const { frontmatter, body } = parseFrontmatter(NOTE_WITH_FULL_FM)
    expect(frontmatter.title).toBe('Research on Agents')
    expect(frontmatter.tags).toEqual(['agents', 'ai', 'claude'])
    expect(frontmatter.date).toBe('2026-09-20')
    expect(frontmatter.url).toBe('https://example.com/agents')
    expect(frontmatter.generated).toBeUndefined()
    expect(body).toContain('Some research notes here.')
  })

  it('detects generated:true', () => {
    const { frontmatter } = parseFrontmatter(NOTE_GENERATED)
    expect(frontmatter.generated).toBe(true)
  })

  it('returns empty frontmatter for note without frontmatter block', () => {
    const { frontmatter, body } = parseFrontmatter(NOTE_NO_FRONTMATTER)
    expect(frontmatter.title).toBeUndefined()
    expect(frontmatter.generated).toBeUndefined()
    expect(body).toContain('Just body content')
  })

  it('handles partial frontmatter', () => {
    const { frontmatter } = parseFrontmatter(NOTE_PARTIAL_FM)
    expect(frontmatter.title).toBe('Partial Note')
    expect(frontmatter.tags).toBeUndefined()
  })
})

// ─── shouldSkip ──────────────────────────────────────────────────────────────

describe('shouldSkip', () => {
  it('skips generated:true files', () => {
    expect(shouldSkip('Research/note.md', { generated: true }, ['Research/'])).toBe(true)
  })

  it('skips files in denylist paths', () => {
    for (const denied of DENYLIST_PATHS) {
      const path = denied.endsWith('/') ? `${denied}something.md` : denied
      expect(shouldSkip(path, {}, ['Research/'])).toBe(true)
    }
  })

  it('skips files NOT in allowlist', () => {
    expect(shouldSkip('SomeOtherFolder/note.md', {}, ['Research/'])).toBe(true)
  })

  it('skips everything when allowlist is empty (no-op)', () => {
    expect(shouldSkip('Research/note.md', {}, [])).toBe(true)
    expect(shouldSkip('Notes/something.md', {}, [])).toBe(true)
  })

  it('includes files matching allowlist', () => {
    expect(shouldSkip('Research/note.md', {}, ['Research/'])).toBe(false)
    expect(shouldSkip('Notes/topic.md', {}, ['Notes/'])).toBe(false)
  })

  it('includes root-level .md files when root wildcard in allowlist', () => {
    expect(shouldSkip('my-note.md', {}, ['*.md'])).toBe(false)
  })

  it('denylist takes priority over allowlist', () => {
    // Even if 'Memories/' is in allowlist, it is still denied
    expect(shouldSkip('Memories/Cold/marveen (Cold).md', {}, ['Memories/'])).toBe(true)
  })
})

// ─── buildMemoriaContent ─────────────────────────────────────────────────────

describe('buildMemoriaContent', () => {
  it('includes title and url when present', () => {
    const note: ParsedNote = {
      relativePath: 'Research/agents.md',
      frontmatter: { title: 'Research on Agents', url: 'https://example.com/agents', tags: ['agents'] },
      body: 'Some body content.',
    }
    const content = buildMemoriaContent(note)
    expect(content).toContain('[Research on Agents](https://example.com/agents)')
    expect(content).toContain('Some body content.')
  })

  it('embeds obsidian-source marker', () => {
    const note: ParsedNote = {
      relativePath: 'Research/agents.md',
      frontmatter: {},
      body: 'Body.',
    }
    const content = buildMemoriaContent(note)
    expect(content).toContain('[obsidian-source: Research/agents.md]')
  })

  it('handles note with no title or url gracefully', () => {
    const note: ParsedNote = {
      relativePath: 'Notes/plain.md',
      frontmatter: {},
      body: 'Just body.',
    }
    const content = buildMemoriaContent(note)
    expect(content).toContain('Just body.')
    expect(content).toContain('[obsidian-source: Notes/plain.md]')
  })
})

// ─── computeHash ─────────────────────────────────────────────────────────────

describe('computeHash', () => {
  it('returns a non-empty string', () => {
    const h = computeHash('some content')
    expect(typeof h).toBe('string')
    expect(h.length).toBeGreaterThan(0)
  })

  it('same content → same hash', () => {
    expect(computeHash('abc')).toBe(computeHash('abc'))
  })

  it('different content → different hash', () => {
    expect(computeHash('abc')).not.toBe(computeHash('xyz'))
  })
})

// ─── ingest (integration) ────────────────────────────────────────────────────

describe('ingest', () => {
  let vaultDir: string
  let client: MemoriaClient

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'obsidian-test-'))
    client = {
      search: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 42 }),
      update: vi.fn().mockResolvedValue(undefined),
    }
  })

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true })
  })

  function cfg(overrides: Partial<IngestConfig> = {}): IngestConfig {
    return {
      vaultPath: vaultDir,
      include: ['Research/'],
      tier: 'warm',
      agentId: 'marveen',
      dryRun: false,
      ...overrides,
    }
  }

  it('returns 0 processed when allowlist is empty (no-op)', async () => {
    mkdirSync(join(vaultDir, 'Research'), { recursive: true })
    writeFileSync(join(vaultDir, 'Research', 'note.md'), NOTE_WITH_FULL_FM)

    const result = await ingest(cfg({ include: [] }), client)

    expect(result.processed).toBe(0)
    expect(client.create).not.toHaveBeenCalled()
  })

  it('skips generated files from denylist paths', async () => {
    mkdirSync(join(vaultDir, 'Memories', 'Cold'), { recursive: true })
    writeFileSync(join(vaultDir, 'Memories', 'Cold', 'marveen (Cold).md'), NOTE_GENERATED)

    const result = await ingest(cfg({ include: ['Memories/'] }), client)

    expect(result.processed).toBe(0)
    expect(client.create).not.toHaveBeenCalled()
  })

  it('skips files with generated:true even in allowlist folders', async () => {
    mkdirSync(join(vaultDir, 'Research'), { recursive: true })
    writeFileSync(join(vaultDir, 'Research', 'generated.md'), NOTE_GENERATED)

    const result = await ingest(cfg(), client)

    expect(result.processed).toBe(0)
    expect(client.create).not.toHaveBeenCalled()
  })

  it('creates a new memoria entry for a valid note', async () => {
    mkdirSync(join(vaultDir, 'Research'), { recursive: true })
    writeFileSync(join(vaultDir, 'Research', 'agents.md'), NOTE_WITH_FULL_FM)

    const result = await ingest(cfg(), client)

    expect(result.processed).toBe(1)
    expect(result.created).toBe(1)
    expect(result.updated).toBe(0)
    expect(client.create).toHaveBeenCalledOnce()
    const callArg = vi.mocked(client.create).mock.calls[0][0]
    expect(callArg.content).toContain('[obsidian-source: Research/agents.md]')
    expect(callArg.keywords).toContain('agents')
  })

  it('updates existing memoria entry on re-ingest (dedup round-trip)', async () => {
    mkdirSync(join(vaultDir, 'Research'), { recursive: true })
    writeFileSync(join(vaultDir, 'Research', 'agents.md'), NOTE_WITH_FULL_FM)

    const existingEntry = { id: 99, contentHash: 'old-hash-not-matching' }
    vi.mocked(client.search).mockResolvedValue(existingEntry)

    const result = await ingest(cfg(), client)

    expect(client.search).toHaveBeenCalledWith('Research/agents.md')
    expect(client.update).toHaveBeenCalledOnce()
    expect(client.create).not.toHaveBeenCalled()
    expect(result.updated).toBe(1)
    expect(result.created).toBe(0)
  })

  it('skips update when content hash is unchanged (no-op on re-ingest)', async () => {
    mkdirSync(join(vaultDir, 'Research'), { recursive: true })
    writeFileSync(join(vaultDir, 'Research', 'agents.md'), NOTE_WITH_FULL_FM)

    // Compute the hash that ingest() will produce for this note
    const { frontmatter, body } = parseFrontmatter(NOTE_WITH_FULL_FM)
    const currentHash = computeHash(
      buildMemoriaContent({ relativePath: 'Research/agents.md', frontmatter, body })
    )
    vi.mocked(client.search).mockResolvedValue({ id: 99, contentHash: currentHash })

    const result = await ingest(cfg(), client)

    expect(client.update).not.toHaveBeenCalled()
    expect(client.create).not.toHaveBeenCalled()
    expect(result.skippedUnchanged).toBe(1)
  })

  it('dry-run: does not call create or update', async () => {
    mkdirSync(join(vaultDir, 'Research'), { recursive: true })
    writeFileSync(join(vaultDir, 'Research', 'agents.md'), NOTE_WITH_FULL_FM)

    const result = await ingest(cfg({ dryRun: true }), client)

    expect(client.create).not.toHaveBeenCalled()
    expect(client.update).not.toHaveBeenCalled()
    expect(result.dryRunListed).toBe(1)
  })

  it('READ-ONLY: vault directory mtime is unchanged after ingest (SEC-critical)', async () => {
    mkdirSync(join(vaultDir, 'Research'), { recursive: true })
    writeFileSync(join(vaultDir, 'Research', 'agents.md'), NOTE_WITH_FULL_FM)

    const mtimeBefore = statSync(join(vaultDir, 'Research')).mtimeMs

    await ingest(cfg(), client)

    const mtimeAfter = statSync(join(vaultDir, 'Research')).mtimeMs
    expect(mtimeAfter).toBe(mtimeBefore)
  })

  it('READ-ONLY: ingest succeeds even when vault is read-only filesystem', async () => {
    mkdirSync(join(vaultDir, 'Research'), { recursive: true })
    writeFileSync(join(vaultDir, 'Research', 'agents.md'), NOTE_WITH_FULL_FM)

    // Make vault read-only -- any accidental write will throw EACCES
    chmodSync(vaultDir, 0o555)
    chmodSync(join(vaultDir, 'Research'), 0o555)

    try {
      await expect(ingest(cfg(), client)).resolves.not.toThrow()
    } finally {
      // Restore so afterEach cleanup (rmSync) works
      chmodSync(vaultDir, 0o755)
      chmodSync(join(vaultDir, 'Research'), 0o755)
    }
  })

  it('processes multiple notes and reports correct counts', async () => {
    mkdirSync(join(vaultDir, 'Research'), { recursive: true })
    writeFileSync(join(vaultDir, 'Research', 'a.md'), NOTE_WITH_FULL_FM)
    writeFileSync(join(vaultDir, 'Research', 'b.md'), NOTE_PARTIAL_FM)
    writeFileSync(join(vaultDir, 'Research', 'skip.md'), NOTE_GENERATED)

    const result = await ingest(cfg(), client)

    expect(result.processed).toBe(2)
    expect(result.skippedGenerated).toBeGreaterThanOrEqual(1)
    expect(client.create).toHaveBeenCalledTimes(2)
  })
})
