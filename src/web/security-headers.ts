// Centralised security response headers for the dashboard HTTP server. Kept as
// a pure function so the policy is unit-tested directly and the request handler
// in web.ts has a single source of truth. HSTS is transport-conditional; the
// content headers (CSP, nosniff, frame-deny) apply on every response because the
// dashboard is now reachable over a public Tailscale Funnel.

export interface SecurityHeaderContext {
  // True when the request reached us over HTTPS (Tailscale Serve terminates TLS
  // and forwards X-Forwarded-Proto: https; a direct loopback hit is plain HTTP).
  isHttps: boolean
}

// Content-Security-Policy for the dashboard. This is a single constant because
// the served surfaces are known and self-contained:
//   - script-src: 'self' plus jsDelivr, which serves the xterm.js terminal libs
//     (web/index.html). There are NO inline <script> blocks and no inline event
//     handlers, and no eval/new Function, so scripts stay 'unsafe-inline'-free --
//     the meaningful XSS defence is kept tight here.
//   - style-src: MUST allow 'unsafe-inline' -- the live UI ships ~188 inline
//     `style=` attributes and 2 inline <style> blocks; jsDelivr also serves the
//     xterm css. (Individual React style props are CSSOM writes, not covered by
//     style-src, but the legacy inline attrs make 'unsafe-inline' unavoidable.)
//   - connect-src 'self': same-origin fetch + the terminal SSE stream
//     (EventSource /api/agents/.../pane/stream). No cross-origin XHR/WebSocket.
//   - img-src / font-src allow 'self' + data: (self-hosted @fontsource woff2 for
//     the /v2 SPA; data: covers any inlined icon/font).
//   - object-src 'none' + frame-ancestors 'none' + base-uri 'self' are the
//     standard clamp-downs; frame-ancestors mirrors X-Frame-Options: DENY.
// External link targets (github.com, api.slack.com) are <a href> navigations,
// which CSP fetch directives do not restrict, so they are intentionally absent.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
].join('; ')

// Build the set of security headers to apply to a response. Pure: same input ->
// same fresh object, no shared mutable state.
export function securityHeaders(ctx: SecurityHeaderContext): Record<string, string> {
  const headers: Record<string, string> = {}

  // Transport-independent content hardening -- emitted on both the plain-HTTP
  // loopback bind and the HTTPS Funnel edge, because a browser can reach the
  // dashboard on either and both benefit from these.
  headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY
  // Stop MIME-sniffing: a response's declared Content-Type is authoritative, so
  // a text/plain body can never be re-interpreted as script/style.
  headers['X-Content-Type-Options'] = 'nosniff'
  // Refuse to be framed (clickjacking defence). frame-ancestors 'none' in the
  // CSP is the modern equivalent; this legacy header covers older browsers.
  headers['X-Frame-Options'] = 'DENY'

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
