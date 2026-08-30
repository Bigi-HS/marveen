// Phase A token migration: the generateClaudeMd() prompt must inject
// $GENESIS_AGENT_TOKEN as the API bearer, not the shared store/.dashboard-token.
//
// Rationale: every new agent's CLAUDE.md shows the API token pattern as examples.
// If those examples point to the shared static token, the agent inherits the wrong
// pattern and bypasses per-agent scope enforcement when Phase B lands.
//
// This test reads agent-scaffold.ts source to assert the template (not the LLM
// output) -- same approach as agent-scaffold-claude-md-prompt.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD_PATH = join(__dirname, '..', 'web', 'agent-scaffold.ts')

const src = readFileSync(SCAFFOLD_PATH, 'utf-8')

// Extract the generateClaudeMd prompt body (lines 300 .. generateSoulMd).
const promptStart = src.indexOf('export async function generateClaudeMd')
const promptEnd = src.indexOf('export async function generateSoulMd')
const promptBody = src.slice(promptStart, promptEnd)

describe('generateClaudeMd: API token pattern uses GENESIS_AGENT_TOKEN (Phase A, e0afd7e9)', () => {
  it('no curl example references store/.dashboard-token', () => {
    // All API call examples must use $GENESIS_AGENT_TOKEN, not the shared static file.
    // Allow non-curl prose mentions (e.g. a migration note explaining the old path)
    // but curl commands must not embed the static token read.
    const curlLines = promptBody
      .split('\n')
      .filter((l) => l.trimStart().startsWith('curl '))

    const staticTokenCurls = curlLines.filter((l) => l.includes('dashboard-token'))
    expect(staticTokenCurls).toEqual([])
  })

  it('at least one curl example uses $GENESIS_AGENT_TOKEN', () => {
    expect(promptBody).toContain('$GENESIS_AGENT_TOKEN')
  })

  it('the explanatory text mentions GENESIS_AGENT_TOKEN (not only the static file)', () => {
    // The prose section that explains "where the token lives" must reference
    // GENESIS_AGENT_TOKEN so agents know to use their per-agent token.
    expect(promptBody).toContain('GENESIS_AGENT_TOKEN')
  })
})
