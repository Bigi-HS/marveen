// Long-lived Server-Sent-Events GET streams share two exemptions from the normal
// /api/* request handling in web.ts: they are skipped by the per-IP rate limiter
// (a stream is one request held open, not a burst), and they may authenticate
// via a ?token= query param because EventSource cannot set an Authorization
// header. Both the per-agent pane stream and the dashboard event bus (card
// 7c7ea226) qualify. Kept in one place so the rate-limit skip and the auth
// token-query allowance can never drift apart.
export function isSseStreamPath(path: string): boolean {
  return /^\/api\/agents\/[^/]+\/pane\/stream$/.test(path) || path === '/api/events/stream'
}
