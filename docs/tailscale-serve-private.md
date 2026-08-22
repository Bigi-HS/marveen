# Tailscale Serve: private-only dashboard access (item5)

Exposes the Genesis dashboard (`127.0.0.1:3420`) to the **tailnet only**, so the
operator can reach it from any of their own tailnet devices (e.g. a phone) with
no public exposure. Managed by `scripts/tailscale-serve-private.sh`.

## Security model

Two independent layers gate access:

1. **Tailnet membership** — Tailscale **Serve** publishes the service only to
   devices in the operator's tailnet. It is reachable from the operator's own
   machines/phone and nothing else. Tailscale **Funnel** (which would publish to
   the public internet) is **never** used; the wrapper hard-asserts Funnel is OFF
   on every `up` and `verify` and aborts otherwise.
2. **Dashboard Bearer token** — every `/api/*` route is gated by the dashboard
   token (`store/.dashboard-token`, constant-time compared). Only the static UI
   shell (`/`, `app.js`, css, avatars) is public so the page can bootstrap; no
   data is served without the token.

Transport is HTTPS using Tailscale's automatic `*.ts.net` certificate, so the
token is never sent in clear text. The dashboard stays bound to `127.0.0.1`;
Serve is the only tailnet ingress.

## Prerequisites

- `tailscaled` running (no systemd on this WSL host; start it manually if down).
- **HTTPS Certificates enabled** for the tailnet in the admin console
  (`https://login.tailscale.com/admin/dns`). Serve cannot provision the cert
  without it; the wrapper's `up` aborts with guidance if the cert can't be issued.

## Usage

```bash
scripts/tailscale-serve-private.sh up       # enable serve (tailnet-only)
scripts/tailscale-serve-private.sh verify    # assert serve-on + funnel-off
scripts/tailscale-serve-private.sh status     # raw serve/funnel status
scripts/tailscale-serve-private.sh reset      # disable serve
```

`up` runs `tailscale serve --bg 3420`, which proxies
`https://<host>.<tailnet>.ts.net/` to `127.0.0.1:3420`, then verifies the mapping
is active and Funnel is off. The config is backgrounded and persisted by
`tailscaled` across restarts.

## Operator test

On a tailnet device (e.g. the phone):

1. Open `https://<host>.<tailnet>.ts.net/` (this host: `bigi.tail1a5fa5.ts.net`).
2. Paste the dashboard access token when prompted (stored in the browser's
   localStorage; delivered out of band, not in the URL).
3. The dashboard loads and is usable.

## Safety invariant

`assert_funnel_off` runs before/around every state-changing action and refuses
to proceed if any Funnel mapping exists. Combined with using only
`tailscale serve` (never `tailscale funnel`), the dashboard cannot be exposed to
the public internet through this tooling.
