# NoA Dashboard (new) — F0

Greenfield, read-only fleet dashboard (card 513b8fd6). Runs on **:3421** and reads
the existing backend on **:3420** via a dev proxy. It never opens the SQLite DB
directly (single-writer invariant) and performs **GET requests only** in F0/F1.

Stack: Vite + React 18 + TypeScript (strict) + Tailwind 3 + lightweight shadcn-style
components. Palette: `store/dashboard-palette-noa.md` (NoA avatar colours), wired as
CSS custom properties in `styles/tokens.css` and Tailwind colour keys.

## F0 scope (this phase)

- Scaffold + dev proxy `/api` → `http://localhost:3420`
- **Mission Control** tab: agent grid (status dot + last-active), "Needs attention"
  block, latest-activity feed — mobile-first
- **Kanban** tab: read-only four-column board with a card-detail drawer

Brain / Agents / Memory / Schedule / Token tabs + SSE arrive in F1.

## Develop

```bash
npm install
# auth: set VITE_DASHBOARD_TOKEN in .env.local, or localStorage["noa-api-token"]
npm run dev        # http://localhost:3421
npm run typecheck  # tsc --noEmit (strict)
npm test           # vitest
npm run build      # tsc -b && vite build -> dist/
```

The backend (:3420) must be running for live data; the proxy keeps the browser
same-origin in dev so no CORS handshake is needed (CORS lands in F1 with SSE).
