"""Medic -- token-free break-glass operator bot (card fc252db2).

Medic is NOT a Claude agent: it has no model and no OAuth credentials, only its
own Telegram bot token. It is a pure-Python daemon (stdlib only, like
hibiki-daily-push) so an OAuth/token outage -- the very failure it exists to
recover -- can never take it down.

Modules:
  dispatch -- pure parse + authorize + allowlist (the injection-proof linchpin)
  patterns -- deterministic health-triage table for `diagnose`
  health   -- deterministic health probes (injected IO) producing a snapshot
  actions  -- command handlers behind an injected executor (no shell, argv only)
  bot      -- the Telegram long-poll loop wiring it together (entry point)
"""
