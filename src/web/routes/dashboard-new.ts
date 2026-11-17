import { existsSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { serveFile } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// ROOT FLIP (card 2d70c06e): dashboard-new SPA is now served from '/'.
// The legacy web/ app has been superseded; /v2 now redirects to '/' for
// backward compat (bookmarks, cached links, scripts).
//
// Behaviour:
//  - /v2 and /v2/* redirect 301 to the equivalent '/' path;
//  - '/' and extension-less client routes fall back to index.html (SPA router);
//  - real files under dist (hashed assets, fonts) are served directly;
//  - a missing path that looks like an asset (has an extension) is 404 -- never
//    return index.html for *.js, that trips the browser strict MIME check.
export function tryHandleDashboardNew(ctx: RouteContext, distDir: string): boolean {
  const { res, path } = ctx

  // Let unhandled /api/* paths fall through to the final 404 in web.ts.
  // Without this guard the SPA catch-all would swallow elided or mistyped
  // API endpoints and return index.html 200 instead of 404.
  if (path.startsWith('/api/')) return false

  // /v2 backward-compat redirect.
  if (path === '/v2' || path === '/v2/') {
    res.writeHead(301, { Location: '/' })
    res.end()
    return true
  }
  if (path.startsWith('/v2/')) {
    // Strip leading slashes from the remainder: /v2//evil.com would otherwise
    // produce Location: //evil.com (protocol-relative open-redirect).
    const remainder = path.slice('/v2/'.length).replace(/^\/+/, '')
    res.writeHead(301, { Location: '/' + remainder })
    res.end()
    return true
  }

  const indexHtml = join(distDir, 'index.html')

  // Root.
  if (path === '/' || path === '') {
    serveFile(res, indexHtml)
    return true
  }

  // Resolve within dist and refuse anything that escapes it (path traversal).
  const distNorm = normalize(distDir)
  const resolved = normalize(join(distDir, path.slice(1)))
  if (resolved !== distNorm && !resolved.startsWith(distNorm + sep)) {
    res.writeHead(403)
    res.end('Forbidden')
    return true
  }

  if (existsSync(resolved) && statSync(resolved).isFile()) {
    serveFile(res, resolved)
    return true
  }

  // Not a real file. An asset-looking request (has a file extension) is a
  // genuine 404; an extension-less client route gets the SPA fallback.
  const last = path.split('/').pop() || ''
  if (last.includes('.')) {
    res.writeHead(404)
    res.end('Not found')
    return true
  }
  serveFile(res, indexHtml)
  return true
}
