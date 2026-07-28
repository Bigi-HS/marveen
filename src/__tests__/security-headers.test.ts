import { describe, it, expect } from 'vitest'
import { securityHeaders } from '../web/security-headers.js'

describe('securityHeaders', () => {
  it('emits HSTS over HTTPS with a 1-year max-age and includeSubDomains', () => {
    const h = securityHeaders({ isHttps: true })
    expect(h['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains')
  })

  it('does not emit HSTS over plain HTTP (loopback bind)', () => {
    const h = securityHeaders({ isHttps: false })
    expect(h['Strict-Transport-Security']).toBeUndefined()
  })

  it('never advertises preload (tailnet-only UI must not pin into the preload list)', () => {
    expect(securityHeaders({ isHttps: true })['Strict-Transport-Security']).not.toContain('preload')
  })

  it('returns a fresh object each call (no shared mutable state)', () => {
    const a = securityHeaders({ isHttps: true })
    a['X-Injected'] = 'mutated'
    const b = securityHeaders({ isHttps: true })
    expect(b['X-Injected']).toBeUndefined()
  })

  // --- transport-independent hardening (card e5b96bfe: public-Funnel exposure) ---
  // These headers must apply on BOTH the plain-HTTP loopback bind and the HTTPS
  // Funnel edge, so they do NOT depend on ctx.isHttps.
  for (const isHttps of [true, false]) {
    it(`emits nosniff, frame-deny and a CSP regardless of transport (isHttps=${isHttps})`, () => {
      const h = securityHeaders({ isHttps })
      expect(h['X-Content-Type-Options']).toBe('nosniff')
      expect(h['X-Frame-Options']).toBe('DENY')
      expect(h['Content-Security-Policy']).toBeTruthy()
    })
  }

  describe('Content-Security-Policy', () => {
    const csp = securityHeaders({ isHttps: true })['Content-Security-Policy']

    it("locks the default fetch directive and base-uri to 'self'", () => {
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("base-uri 'self'")
    })

    it('forbids plugins and framing (object-src none, frame-ancestors none)', () => {
      expect(csp).toContain("object-src 'none'")
      expect(csp).toContain("frame-ancestors 'none'")
    })

    it("keeps scripts restricted to self + the xterm CDN, never 'unsafe-inline'", () => {
      // The live dashboard loads xterm from jsDelivr; it has NO inline <script>
      // and no inline event handlers, so script execution stays hash-tight.
      expect(csp).toMatch(/script-src [^;]*'self'/)
      expect(csp).toMatch(/script-src [^;]*https:\/\/cdn\.jsdelivr\.net/)
      expect(csp).not.toMatch(/script-src [^;]*'unsafe-inline'/)
      expect(csp).not.toContain("'unsafe-eval'")
    })

    it("allows inline styles (the UI ships ~188 style= attrs) + the xterm CDN css", () => {
      expect(csp).toMatch(/style-src [^;]*'self'/)
      expect(csp).toMatch(/style-src [^;]*'unsafe-inline'/)
      expect(csp).toMatch(/style-src [^;]*https:\/\/cdn\.jsdelivr\.net/)
    })

    it('allows same-origin XHR/SSE and self+data images and fonts', () => {
      expect(csp).toContain("connect-src 'self'")
      expect(csp).toMatch(/img-src [^;]*'self'/)
      expect(csp).toMatch(/img-src [^;]*data:/)
      expect(csp).toMatch(/font-src [^;]*'self'/)
    })
  })
})
