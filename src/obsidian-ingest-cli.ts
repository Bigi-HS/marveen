#!/usr/bin/env node
// CLI entry-point for the Obsidian vault → memoria ingest (MEM-J3, e94acbc5).
//
// Usage:
//   node dist/obsidian-ingest-cli.js \
//     --vault-path /mnt/c/Users/domin/Documents/NoA-Vault \
//     --include Research/ \
//     --include Notes/ \
//     --tier warm \
//     [--dry-run]
//
// Empty --include list = no-op (0 files processed). This is intentional: the
// ingest infrastructure is built but safe until Dominik designates folders.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { ingest, type IngestConfig, type MemoriaClient, type MemoriaEntry } from './obsidian-ingest.js'

// ─── CLI arg parsing ─────────────────────────────────────────────────────────

interface CliArgs {
  vaultPath: string
  include: string[]
  exclude: string[]
  tier: string
  agentId: string
  dryRun: boolean
  apiBase: string
  tokenFile: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    vaultPath: '',
    include: [],
    exclude: [],
    tier: 'warm',
    agentId: 'marveen',
    dryRun: false,
    apiBase: 'http://localhost:3420',
    tokenFile: 'store/.dashboard-token',
  }

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--vault-path': args.vaultPath = argv[++i]; break
      case '--include': args.include.push(argv[++i]); break
      case '--exclude': args.exclude.push(argv[++i]); break
      case '--tier': args.tier = argv[++i]; break
      case '--agent-id': args.agentId = argv[++i]; break
      case '--dry-run': args.dryRun = true; break
      case '--api-base': args.apiBase = argv[++i]; break
      case '--token-file': args.tokenFile = argv[++i]; break
    }
  }

  return args
}

// ─── HTTP MemoriaClient ───────────────────────────────────────────────────────

function makeClient(apiBase: string, token: string): MemoriaClient {
  async function apiFetch(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`API ${method} ${path} → ${res.status}: ${text}`)
    }
    if (res.status === 204) return null
    return res.json()
  }

  return {
    async search(sourceMarker: string): Promise<{ id: number; contentHash: string } | null> {
      const q = encodeURIComponent(`obsidian-source: ${sourceMarker}`)
      const data = await apiFetch(`/api/memories?agent=marveen&q=${q}&limit=5`) as unknown[]
      const list = Array.isArray(data) ? data : (data as Record<string, unknown[]>).memories ?? []
      const hit = (list as Array<{ id: number; content: string }>).find(m =>
        m.content?.includes(`[obsidian-source: ${sourceMarker}]`)
      )
      if (!hit) return null
      const hash = createHash('sha1').update(hit.content, 'utf8').digest('hex').slice(0, 16)
      return { id: hit.id, contentHash: hash }
    },

    async create(entry: MemoriaEntry): Promise<{ id: number }> {
      const body = {
        agent_id: entry.agentId,
        content: entry.content,
        category: entry.tier,
        keywords: entry.keywords,
      }
      const res = await apiFetch('/api/memories', 'POST', body) as { id: number }
      return { id: res.id }
    },

    async update(id: number, entry: MemoriaEntry): Promise<void> {
      await apiFetch(`/api/memories/${id}`, 'PATCH', {
        content: entry.content,
        keywords: entry.keywords,
        category: entry.tier,
      })
    },
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`
obsidian-ingest-cli -- Obsidian vault -> memoria ingest (MEM-J3)

Options:
  --vault-path <path>    Vault root (required)
  --include <pattern>    Folder/glob to include (repeatable; empty = no-op)
  --exclude <pattern>    Extra excludes beyond built-in denylist (repeatable)
  --tier <tier>          Memory tier: warm (default), cold, shared
  --agent-id <id>        Agent ID for memories (default: marveen)
  --dry-run              List files without writing to memoria
  --api-base <url>       Dashboard API base (default: http://localhost:3420)
  --token-file <path>    Path to .dashboard-token (default: store/.dashboard-token)

Built-in denylist (always excluded to prevent feedback loops):
  Memories/, Daily Log/, Views/, Home.md, Welcome.md

Examples:
  # Dry run -- see what would be ingested
  node dist/obsidian-ingest-cli.js --vault-path /mnt/c/.../NoA-Vault --include Research/ --dry-run

  # Ingest Research folder as warm memories
  node dist/obsidian-ingest-cli.js --vault-path /mnt/c/.../NoA-Vault --include Research/ --tier warm
`)
    process.exit(0)
  }

  const cli = parseArgs(argv)

  if (!cli.vaultPath) {
    process.stderr.write('Error: --vault-path is required\n')
    process.exit(1)
  }

  if (!existsSync(cli.vaultPath)) {
    process.stderr.write(`Error: vault path does not exist: ${cli.vaultPath}\n`)
    process.exit(1)
  }

  let token: string
  try {
    token = readFileSync(cli.tokenFile, 'utf8').split('\n')[0].trim()
  } catch {
    process.stderr.write(`Error: cannot read token file: ${cli.tokenFile}\n`)
    process.exit(1)
  }

  const config: IngestConfig = {
    vaultPath: cli.vaultPath,
    include: cli.include,
    exclude: cli.exclude,
    tier: cli.tier,
    agentId: cli.agentId,
    dryRun: cli.dryRun,
  }

  const client = makeClient(cli.apiBase, token)

  if (cli.dryRun) {
    process.stdout.write('[dry-run] No writes to vault or memoria.\n')
  }

  if (cli.include.length === 0) {
    process.stdout.write('No --include patterns specified. Allowlist is empty -- 0 files will be processed.\n')
    process.stdout.write('Use --include <folder/> to designate Obsidian folders for ingest.\n')
  }

  const result = await ingest(config, client)

  process.stdout.write(JSON.stringify({
    processed: result.processed,
    created: result.created,
    updated: result.updated,
    skippedGenerated: result.skippedGenerated,
    skippedDenylist: result.skippedDenylist,
    skippedNotInAllowlist: result.skippedNotInAllowlist,
    skippedUnchanged: result.skippedUnchanged,
    dryRunListed: result.dryRunListed,
  }, null, 2) + '\n')
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
