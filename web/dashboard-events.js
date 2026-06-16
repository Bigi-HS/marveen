// Dashboard SSE client (card 7c7ea226, opencode push layer). Loaded as a classic
// <script> before app.js; exposes window.DashboardEvents. Subscribes to the
// multiplexed /api/events/stream and turns kanban/message push events into
// coalesced refreshes of the active view. Thin-notify: the event carries only
// {type,id,action}, so the handler just re-fetches -- no payload parsing here.
//
// AUGMENT model (NoA lock fork D): this layers live updates on top of the
// existing on-demand fetches; if the stream drops, EventSource auto-reconnects
// and the manual/page-enter fetches still work. The kanban + message views were
// never interval-polled, so there is no redundant poller to throttle here.
;(function (root, factory) {
  var api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.DashboardEvents = api
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict'

  // Collapse a burst of triggers into ONE deferred call (NoA build-note #1). The
  // first trigger schedules the call; further triggers inside the window are
  // absorbed -- the single fire re-fetches fresh state covering all of them.
  function makeCoalescer(fn, delayMs) {
    var timer = null
    return function () {
      if (timer) return
      timer = setTimeout(function () {
        timer = null
        fn()
      }, delayMs)
    }
  }

  // Open the dashboard event stream and route each SSE topic to a coalesced
  // refresh callback. EventSourceCtor is injectable for tests; defaults to the
  // browser global. Returns the EventSource, or null if SSE is unavailable.
  function initDashboardEvents(opts) {
    opts = opts || {}
    var Ctor = opts.EventSourceCtor !== undefined
      ? opts.EventSourceCtor
      : (typeof EventSource !== 'undefined' ? EventSource : null)
    if (!Ctor) return null

    var url = opts.url || '/api/events/stream'
    var delayMs = opts.delayMs || 120
    // Same-origin EventSource sends the HttpOnly session cookie automatically.
    var es = new Ctor(url, { withCredentials: true })

    if (typeof opts.onKanban === 'function') {
      es.addEventListener('kanban', makeCoalescer(opts.onKanban, delayMs))
    }
    if (typeof opts.onMessage === 'function') {
      es.addEventListener('message', makeCoalescer(opts.onMessage, delayMs))
    }
    return es
  }

  return { makeCoalescer: makeCoalescer, initDashboardEvents: initDashboardEvents }
})
