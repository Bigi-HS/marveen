import { describe, it, expect } from 'vitest'
import { isPublicApiPath } from '../web/public-paths.js'

// These assert the REAL predicate src/web.ts uses for its auth-gate bypass, so
// the allowlist cannot silently drift from the dispatcher (the gap that let
// POST /api/health/ingest ship reachable-in-dispatcher yet 401'd by the gate).
describe('isPublicApiPath', () => {
  it('exempts GET /api/auth/status (credential-existence probe, no secret)', () => {
    expect(isPublicApiPath('/api/auth/status', 'GET')).toBe(true)
    // Only GET -- a POST to it is not a public path.
    expect(isPublicApiPath('/api/auth/status', 'POST')).toBe(false)
  })

  it('exempts the avatar images (GET only)', () => {
    expect(isPublicApiPath('/api/marveen/avatar', 'GET')).toBe(true)
    expect(isPublicApiPath('/api/agents/hibiki/avatar', 'GET')).toBe(true)
    expect(isPublicApiPath('/api/agents/dave/avatar', 'POST')).toBe(false)
  })

  describe('POST /api/health/ingest (WELL-018 tunnel ingress)', () => {
    it('is public for POST so its own X-Ingest-Token gate can run', () => {
      expect(isPublicApiPath('/api/health/ingest', 'POST')).toBe(true)
    })

    it('stays GATED for any other method (only POST is public)', () => {
      expect(isPublicApiPath('/api/health/ingest', 'GET')).toBe(false)
      expect(isPublicApiPath('/api/health/ingest', 'DELETE')).toBe(false)
      expect(isPublicApiPath('/api/health/ingest', 'PUT')).toBe(false)
    })

    it('does not exempt look-alike or sub-paths', () => {
      expect(isPublicApiPath('/api/health/ingest/x', 'POST')).toBe(false)
      expect(isPublicApiPath('/api/health', 'POST')).toBe(false)
      expect(isPublicApiPath('/api/health/ingestx', 'POST')).toBe(false)
    })
  })

  it('gates every other /api path', () => {
    expect(isPublicApiPath('/api/memories', 'GET')).toBe(false)
    expect(isPublicApiPath('/api/kanban', 'POST')).toBe(false)
    expect(isPublicApiPath('/api/gate/approve', 'POST')).toBe(false)
    expect(isPublicApiPath('/api/agents/dave/pane/stream', 'GET')).toBe(false)
  })
})
