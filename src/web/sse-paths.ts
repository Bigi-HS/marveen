// Long-lived Server-Sent-Events GET streams are skipped by the per-IP rate
// limiter in web.ts: a stream is one request held open, not a burst, so it must
// not count against the burst budget. Both the per-agent pane stream and the
// dashboard event bus (card 7c7ea226) qualify. Kept in one place so the
// rate-limit skip can't drift across the two stream paths. Auth is the normal
// cookie/bearer gate -- same-origin EventSource sends the HttpOnly session
// cookie automatically (withCredentials), so there is NO query-param token
// allowance (the legacy ?token= fallback was removed in card 32bcf962).
export function isSseStreamPath(path: string): boolean {
  return /^\/api\/agents\/[^/]+\/pane\/stream$/.test(path) || path === '/api/events/stream'
}
