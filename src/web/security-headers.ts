// Centralised security response headers for the dashboard HTTP server. Kept as
// a pure function so the policy is unit-tested directly and the request handler
// in web.ts has a single source of truth. Today this is HSTS only; further
// headers (CSP, X-Content-Type-Options, ...) can join here without touching the
// request loop.

export interface SecurityHeaderContext {
  // True when the request reached us over HTTPS (Tailscale Serve terminates TLS
  // and forwards X-Forwarded-Proto: https; a direct loopback hit is plain HTTP).
  isHttps: boolean
}

// Build the set of security headers to apply to a response. Pure: same input ->
// same fresh object, no shared mutable state.
export function securityHeaders(ctx: SecurityHeaderContext): Record<string, string> {
  const headers: Record<string, string> = {}
  // HSTS: once a browser has reached the dashboard over HTTPS, pin HTTPS for a
  // year so any later plain-HTTP attempt is auto-upgraded before a request is
  // sent. Emitted ONLY on HTTPS: on the plain-HTTP loopback bind the header is
  // ignored by browsers anyway, and we avoid asserting a transport policy we
  // cannot honour on that interface. No `preload` (that is a standing
  // submission to the browser preload list, far beyond this tailnet-only UI).
  if (ctx.isHttps) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
  }
  return headers
}
