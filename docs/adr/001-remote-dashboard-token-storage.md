# ADR-001: Remote Dashboard Token Storage -- localStorage Accepted

**Date**: 2026-06-05  
**Status**: accepted  
**Decider(s)**: Dominik  
**Area**: security

---

## Context

The Genesis dashboard (localhost:3420) is being made accessible remotely via a private Tailscale network. The dashboard uses a Bearer token for authentication. During spec review (store/specs/remote-dashboard-access.md), the question arose of where the token should be stored in the browser on the remote device.

Three options exist: in-memory only (cleared on page reload), sessionStorage (cleared on tab/browser close), or localStorage (persists until manually cleared). The risk of persistent storage is that a compromised device retains the token across reboots, extending the attack window. The mitigating factor is that access is gated behind the Tailscale private network -- an attacker with physical device access and a stolen localStorage token still cannot reach the dashboard without also being enrolled in the Tailscale network.

## Decision

localStorage is accepted for remote dashboard token storage. This is Dominik's explicit choice, prioritizing convenience (no re-entry on every page load) over the theoretical compromised-device risk, given the private Tailscale network boundary.

## Alternatives considered and why not

| Alternative | Why rejected |
|---|---|
| In-memory only | Token lost on every page reload; impractical on mobile where tabs are frequently killed by the OS |
| sessionStorage | Better than localStorage but still requires re-entry on every new tab/browser restart; rejected as unnecessarily inconvenient given the Tailscale boundary mitigates the main risk |

## Consequences

### Positive
- No re-entry required after browser restart or device reboot
- Practical for mobile use where OS aggressively kills tabs

### Negative / tradeoffs
- A compromised device (stolen phone/laptop) with a valid localStorage token could be used to access the dashboard -- but only from within the Tailscale network
- If the Tailscale private boundary is breached, token persistence extends the exposure window

### Risks and mitigations
- Compromised device + Tailscale access: mitigated by removing the device from the Tailscale network immediately on loss/compromise
- Token rotation: the dashboard token should be rotatable via the admin UI without restarting the server; if not currently possible, this is a follow-up item

## Links

- Related specs: `store/specs/remote-dashboard-access.md` (AC5)
- Cold memory keywords: localStorage, token storage, remote dashboard, security tradeoff, Tailscale
