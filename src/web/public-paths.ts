// Allowlist of /api/* paths that BYPASS the dashboard bearer/session auth gate
// (src/web.ts). Every entry either carries NO secret or has its OWN dedicated
// auth mechanism, so it is safe to reach without a dashboard bearer/session:
//   - GET  /api/auth/status         reveals only THAT a credential exists (no secret)
//   - GET  /api/marveen/avatar      public profile image
//   - GET  /api/agents/<id>/avatar  public profile image
//   - POST /api/health/ingest       WELL-018 Health-Connect ingress. Reached over
//       the PUBLIC Cloudflare tunnel by the phone, which sends only its dedicated
//       X-Ingest-Token (distinct from the dashboard bearer). It MUST bypass the
//       dashboard-auth gate so its own token check (routes/health-ingest.ts) runs;
//       otherwise the gate 401s the phone before the ingest-token gate is reached.
//       Only POST is public -- any other method stays gated.
//
// This lives in its own dependency-free module so it can be unit-tested against
// the REAL predicate the server uses. The prior inline copy in web.ts was never
// exercised by an integration test, which is how POST /api/health/ingest shipped
// reachable in the dispatcher yet unreachable behind the auth gate.
export function isPublicApiPath(path: string, method: string): boolean {
  if (path === '/api/auth/status' && method === 'GET') return true
  if (path === '/api/health/ingest' && method === 'POST') return true
  if (method === 'GET') {
    if (path === '/api/marveen/avatar') return true
    if (/^\/api\/agents\/[^/]+\/avatar$/.test(path)) return true
  }
  return false
}
