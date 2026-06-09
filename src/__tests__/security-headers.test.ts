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
    expect(Object.keys(h)).toHaveLength(0)
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
})
