// Pure helpers for the message-router's "never drop silently" guard
// (card d3339db9). When an inter-agent message is abandoned after the
// retry window, the router enqueues an alert to the main agent so a
// delivery failure is always surfaced -- even if a future pane-detector
// gap re-introduces a false-busy. Kept dependency-free so it is
// unit-testable without tmux or the DB.

// Sender id for delivery-monitor alerts. A CODE CONSTANT, never a real
// agent: it exists only so the recursion guard can recognise the router's
// own alerts and not alert about an alert.
export const DELIVERY_MONITOR_AGENT_ID = 'delivery-monitor'

/**
 * Should an abandoned inter-agent message spawn a delivery-dropped alert
 * to the main agent? True for ordinary messages; false when the abandoned
 * message is itself a delivery-monitor alert (recursion guard: if the main
 * agent is unreachable for the whole window, one dropped alert must not
 * cascade into an unbounded chain of alerts-about-alerts).
 */
export function shouldAlertOnAbandon(fromAgent: string): boolean {
  return fromAgent !== DELIVERY_MONITOR_AGENT_ID
}

/**
 * Human-readable alert body for a dropped inter-agent message. Names the
 * id, the parties, and the age so the main agent can investigate the
 * target's session and re-send. States plainly that the message was NOT
 * delivered -- the d3339db9 pain was that the drop was invisible.
 */
export function abandonAlertContent(
  msg: { id: number; from_agent: string; to_agent: string },
  ageMs: number,
): string {
  const mins = Math.round(ageMs / 60000)
  return (
    `DELIVERY DROPPED: inter-agent message #${msg.id} from "${msg.from_agent}" ` +
    `to "${msg.to_agent}" was abandoned after ${mins} min (target session never ` +
    `became ready for a prompt). The message was NOT delivered. Check ` +
    `"${msg.to_agent}"'s session health and re-send if it still matters.`
  )
}
