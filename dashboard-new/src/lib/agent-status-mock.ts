/**
 * Mock payload for GET /api/agents/status (card 8c823cdc).
 * Shape matches the agreed contract (dave msg 16867, 2026-09-28).
 * Replace with real fetch once the poller PR lands.
 *
 * Covers all 5 states + stale-guard edge case (scout: token_data_fresh=false
 * -> status IDLE-OK not NO-TOKEN, tooltip shows 'token-data stale' caveat).
 */
export const AGENT_STATUS_MOCK = {
  agents: [
    {
      agent_id: 'dave',
      status: 'WORKING',
      status_reason: 'processing a gate review',
      last_updated: '2026-09-28T15:40:00Z',
      keepalive_age_s: 18,
      token_data_fresh: true,
    },
    {
      agent_id: 'marveen',
      status: 'RECEIVED',
      status_reason: 'task delivered, starting',
      last_updated: '2026-09-28T15:39:55Z',
      keepalive_age_s: 42,
      token_data_fresh: true,
    },
    {
      agent_id: 'thor',
      status: 'ERROR',
      status_reason: 'stuck-input wedge (unstick mode C)',
      last_updated: '2026-09-28T15:39:00Z',
      keepalive_age_s: 2600,
      token_data_fresh: true,
    },
    {
      agent_id: 'rackham',
      status: 'NO-TOKEN',
      status_reason: 'usage-limit; only n8n basics running',
      last_updated: '2026-09-28T15:40:00Z',
      keepalive_age_s: 300,
      token_data_fresh: true,
    },
    {
      agent_id: 'forge',
      status: 'IDLE-OK',
      status_reason: 'keepalive fresh, no pending work',
      last_updated: '2026-09-28T15:40:00Z',
      keepalive_age_s: 95,
      token_data_fresh: true,
    },
    {
      agent_id: 'scout',
      status: 'IDLE-OK',
      status_reason: 'token-data stale (cron>10min); classified by keepalive',
      last_updated: '2026-09-28T15:40:00Z',
      keepalive_age_s: 120,
      token_data_fresh: false,
    },
  ],
  computed_at: '2026-09-28T15:40:05Z',
} as const
