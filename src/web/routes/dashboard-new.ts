import { existsSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { serveFile } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const PREFIX = '/v2'

// Serves the built dashboard-new SPA (Vite) under /v2, side-by-side with the
// legacy web/ app on '/'. This is the parallel-mount step of the cutover: the
// legacy dashboard stays authoritative on '/', /v2 is opt-in until a proven
// feature-parity flip. Vite is built with base '/v2/' so asset URLs already
// carry the prefix.
//
// Behaviour:
//  - a real file under dist is served directly (hashed assets, fonts, index);
//  - an extension-less path (a client route like /v2/gate) falls back to
//    index.html so deep-links and reloads reach the SPA router;
//  - a missing path that looks like an asset (has an extension) is a 404, not
//    an html fallback -- returning index.html for a *.js request would trip the
//    browser's strict MIME check and mask the real 404.
export function tryHandleDashboardNew(ctx: RouteContext, distDir: string): boolean {
  const { res, path } = ctx
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false

  const indexHtml = join(distDir, 'index.html')

  // '/v2' and '/v2/' both map to the SPA entry.
  const rel = path === PREFIX ? '' : path.slice(PREFIX.length + 1)
  if (rel === '') {
    serveFile(res, indexHtml)
    return true
  }

  // Resolve within dist and refuse anything that escapes it (path traversal).
  const distNorm = normalize(distDir)
  const resolved = normalize(join(distDir, rel))
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
  const last = rel.split('/').pop() || ''
  if (last.includes('.')) {
    res.writeHead(404)
    res.end('Not found')
    return true
  }
  serveFile(res, indexHtml)
  return true
}
