/**
 * SECURITY TRIPWIRE: MCP usage is stdio-only (card a91b42a9, SEC-028).
 *
 * Context (chad triage 2026-08-04): the @modelcontextprotocol/sdk ships
 * express + hono + body-parser + qs + express-rate-limit + ip-address in its
 * own package.json, but our usage (McpServer + StdioServerTransport) only
 * pulls in the stdio entry points.  Those transitive packages are installed
 * but NOT loaded at runtime, so the advisories on them are unreachable.
 *
 * This test FAILS when:
 *   - someone switches google-mcp-server.ts to an HTTP transport, or
 *   - the installed SDK's stdio entry point gains an express/hono import.
 *
 * Both transitions would silently activate the express/hono advisory surface
 * without triggering any visible code review alarm -- this test is that alarm.
 * If this test fails: perform a new security review before proceeding.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const MCP_SERVER_SRC = resolve(
  import.meta.dirname,
  '..',
  'mcp',
  'google-mcp-server.ts',
)

const SDK_ROOT = resolve(
  import.meta.dirname,
  '..',
  '..',
  'node_modules',
  '@modelcontextprotocol',
  'sdk',
)

const FORBIDDEN_MODULES = [
  'express',
  '@hono/node-server',
  'hono',
  'express-rate-limit',
  'body-parser',
  'qs',
]

/**
 * Collect all relative imports reachable from a dist/esm entry point.
 * Does NOT cross into node_modules (only relative ./... imports).
 */
function transitiveRelativeImports(entryPath: string): Set<string> {
  const visited = new Set<string>()
  const queue = [entryPath]

  while (queue.length) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)

    if (!existsSync(current)) continue
    const src = readFileSync(current, 'utf8')

    // Match ES import/export from './...' or '../...'
    const relImportRe = /from ['"](\.[^'"]+)['"]/g
    let m: RegExpExecArray | null
    while ((m = relImportRe.exec(src)) !== null) {
      const rel = m[1]
      const dir = current.replace(/\/[^/]+$/, '')
      let abs = rel.startsWith('.') ? resolve(dir, rel) : rel
      // Resolve .js -> actual .js file
      if (!abs.endsWith('.js') && !abs.endsWith('.ts')) {
        abs += '.js'
      }
      if (!visited.has(abs)) {
        queue.push(abs)
      }
    }
  }
  return visited
}

describe('MCP stdio-only tripwire (SEC-028 / a91b42a9)', () => {
  it('google-mcp-server.ts imports McpServer from server/mcp.js and StdioServerTransport from server/stdio.js only', () => {
    const src = readFileSync(MCP_SERVER_SRC, 'utf8')

    // Must import McpServer (stdio server) and StdioServerTransport
    expect(src, 'McpServer import missing').toMatch(
      /from ['"]@modelcontextprotocol\/sdk\/server\/mcp\.js['"]/,
    )
    expect(src, 'StdioServerTransport import missing').toMatch(
      /from ['"]@modelcontextprotocol\/sdk\/server\/stdio\.js['"]/,
    )

    // Must NOT import HTTP transport or auth router paths
    const HTTP_TRANSPORT_PATHS = [
      '/server/streamableHttp',
      '/server/express',
      '/server/sse',
      '/server/auth',
      '/server/middleware',
    ]
    for (const forbidden of HTTP_TRANSPORT_PATHS) {
      expect(
        src,
        `SECURITY REVIEW NEEDED: google-mcp-server.ts imports ${forbidden}. ` +
          `Switching to HTTP transport activates the express/hono advisory surface. ` +
          `Run a new security review before merging (card a91b42a9).`,
      ).not.toContain(forbidden)
    }
  })

  it('SDK server/mcp.js and server/stdio.js transitive imports do not include express/hono cluster', () => {
    const mcpEntry = resolve(SDK_ROOT, 'dist', 'esm', 'server', 'mcp.js')
    const stdioEntry = resolve(SDK_ROOT, 'dist', 'esm', 'server', 'stdio.js')

    expect(existsSync(mcpEntry), `MCP SDK entry not found: ${mcpEntry}`).toBe(true)
    expect(existsSync(stdioEntry), `MCP SDK entry not found: ${stdioEntry}`).toBe(true)

    const mcpImports = transitiveRelativeImports(mcpEntry)
    const stdioImports = transitiveRelativeImports(stdioEntry)

    // Neither entry point should pull express.js or the streamableHttp transport
    const httpPaths = [
      resolve(SDK_ROOT, 'dist', 'esm', 'server', 'express.js'),
      resolve(SDK_ROOT, 'dist', 'esm', 'server', 'streamableHttp.js'),
      resolve(SDK_ROOT, 'dist', 'esm', 'server', 'sse.js'),
    ]

    for (const httpPath of httpPaths) {
      const inMcp = mcpImports.has(httpPath)
      const inStdio = stdioImports.has(httpPath)
      expect(
        inMcp || inStdio,
        `SECURITY REVIEW NEEDED: ${httpPath} appeared in the transitive import closure of the ` +
          `SDK stdio entry points. The express/hono advisory surface is now reachable. ` +
          `Run a new security review before merging (card a91b42a9).`,
      ).toBe(false)
    }
  })

  it('installed SDK does not load forbidden modules at the node_modules boundary', () => {
    // Verify the SDK package.json declares these as dependencies (they're installed)
    // but our entry points do not transitively require them.
    const sdkPkg = JSON.parse(
      readFileSync(resolve(SDK_ROOT, 'package.json'), 'utf8'),
    )
    const sdkDeps = Object.keys(sdkPkg.dependencies ?? {})

    const installedForbidden = FORBIDDEN_MODULES.filter((m) =>
      sdkDeps.includes(m),
    )

    // They are listed as SDK deps (this verifies our threat model is current)
    expect(
      installedForbidden.length,
      'None of the forbidden modules are SDK deps anymore -- update the threat model comment',
    ).toBeGreaterThan(0)

    // But they must NOT appear as imports in our two entry point source files
    const mcpSrc = readFileSync(
      resolve(SDK_ROOT, 'dist', 'esm', 'server', 'mcp.js'),
      'utf8',
    )
    const stdioSrc = readFileSync(
      resolve(SDK_ROOT, 'dist', 'esm', 'server', 'stdio.js'),
      'utf8',
    )

    for (const mod of installedForbidden) {
      const inMcp = mcpSrc.includes(`from '${mod}'`) || mcpSrc.includes(`require('${mod}')`)
      const inStdio = stdioSrc.includes(`from '${mod}'`) || stdioSrc.includes(`require('${mod}')`)
      expect(
        inMcp || inStdio,
        `SECURITY REVIEW NEEDED: '${mod}' appeared as a direct import in the SDK's ` +
          `mcp.js or stdio.js entry points. The advisory surface is now reachable at runtime. ` +
          `Run a new security review before merging (card a91b42a9).`,
      ).toBe(false)
    }
  })
})
