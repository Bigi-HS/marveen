// Token-outage Layer-2 per-agent emergency-routing policy (card d1ccf1d9).
//
// The L2 fallback-LLM client (scripts/fallback_llm_client.py, card 92f07145) can
// route narrow structured tasks to an external hosted LLM (Groq/Gemini) while the
// shared Claude account is usage-limited. That client enforces sensitivity-based
// PROVIDER routing internally. This module adds a SECOND, independent gate on the
// NODE side, consulted BEFORE the client is ever invoked: a per-agent policy that
// decides whether a given agent may route a given task-type to ANY external LLM at
// all, and caps the sensitivity of content allowed to leave the box.
//
// Defence-in-depth: the python client classifies + redacts; this gate can only ever
// be STRICTER (deny what the client would allow), never looser. The two layers are
// independent so a regression in one does not open an egress path.
//
// HARD RULE (PII-local): an agent flagged `piiLocal` NEVER egresses to an external
// LLM, regardless of task config. Personal/health data stays local, full stop.

export type Layer2TaskType = 'kanban_card_from_text' | 'reminder_parse' | 'coaching_reply'
export type EgressSensitivity = 'low' | 'medium' | 'high'

// low < medium < high. A higher rank = more sensitive content.
const SENSITIVITY_RANK: Record<EgressSensitivity, number> = { low: 1, medium: 2, high: 3 }

export interface AgentEmergencyPolicy {
  // When true, the agent NEVER egresses to an external LLM (highest-priority block).
  piiLocal: boolean
  // The narrow task-types this agent may route to the fallback LLM during an outage.
  allowedTaskTypes: readonly Layer2TaskType[]
  // Ceiling: a task's effective sensitivity must be <= this to egress. Conservative
  // default 'low' so even non-PII-local agents cannot leak sensitive task content.
  maxEgressSensitivity: EgressSensitivity
  // One-line audit rationale for why this agent is listed (and why PII-local or not).
  rationale: string
}

export interface RoutingDecision {
  allowed: boolean
  // Machine-readable outcome; 'ok' when allowed, otherwise the block reason.
  reason: string
}

// Per-agent registry. An auditable code constant (NOT YAML) so there is no
// config-tamper vector to widen egress -- STRIDE T1-safe. Each entry carries a
// one-line rationale for the listing.
export const EMERGENCY_ROUTING_POLICY: Record<string, AgentEmergencyPolicy> = {
  // PII-local: handles body-metric / health data; fitness context must stay local.
  hibiki: {
    piiLocal: true,
    allowedTaskTypes: [],
    maxEgressSensitivity: 'low',
    rationale: 'Health/body-metric data; personal fitness context must never leave the box.',
  },
  // PII-local: handles personal calendar + email content; PII must stay local.
  claudia: {
    piiLocal: true,
    allowedTaskTypes: [],
    maxEgressSensitivity: 'low',
    rationale: 'Personal calendar/email content; PII must never reach an external LLM.',
  },
  // NoA orchestrator: may route narrow ops tasks for its own survival routing, but
  // the low ceiling blocks raw Boss-DM content from leaving the box.
  marveen: {
    piiLocal: false,
    allowedTaskTypes: ['reminder_parse', 'kanban_card_from_text'],
    maxEgressSensitivity: 'low',
    rationale: 'Orchestrator survival routing; low ceiling blocks raw Boss-DM egress.',
  },
  // Tutor: short coaching replies only.
  // EXPLICIT DECISION (card d1ccf1d9, marveen + Chad early-ack): bond is
  // deliberately NOT PII-local. Coaching replies are study/tutoring content, not
  // personal/health/financial data. The health/finance edge case (a coaching
  // prompt that happens to mention medical or money terms) is caught by the
  // python client's keyword guard (spec 5.5), which reclassifies such a prompt to
  // high sensitivity -- and the low ceiling here then blocks it from egress. So
  // the omission from the PII-local set is a reviewed choice, not an oversight.
  bond: {
    piiLocal: false,
    allowedTaskTypes: ['coaching_reply'],
    maxEgressSensitivity: 'low',
    rationale: 'Coaching replies only; NOT PII-local by decision; health-keyword edge guarded in client + low ceiling.',
  },
}

// Any agent not explicitly listed: deny-by-default. An unlisted agent cannot
// silently route content to an external LLM -- a policy must be declared and
// reviewed before any egress is possible.
export const DEFAULT_POLICY: AgentEmergencyPolicy = {
  piiLocal: false,
  allowedTaskTypes: [],
  maxEgressSensitivity: 'low',
  rationale: 'Unlisted agent: deny-by-default, no emergency egress.',
}

export function getAgentPolicy(agent: string): AgentEmergencyPolicy {
  return EMERGENCY_ROUTING_POLICY[agent] ?? DEFAULT_POLICY
}

export function isLayer2TaskType(t: string): t is Layer2TaskType {
  return t === 'kanban_card_from_text' || t === 'reminder_parse' || t === 'coaching_reply'
}

// Effective sensitivity: absent/invalid -> 'high' (fail-safe). Mirrors the python
// client's T2 default so this gate never under-classifies content as less sensitive
// than the client would.
export function normalizeSensitivity(raw: string | undefined | null): EgressSensitivity {
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw
  return 'high'
}

// Core pure decision. Order matters: PII-local block is checked FIRST and is
// absolute. The gate is stricter-only -- it returns allowed:false on any doubt.
export function evaluateEmergencyRouting(
  agent: string,
  taskType: string,
  sensitivity: string | undefined | null,
): RoutingDecision {
  const policy = getAgentPolicy(agent)

  // 1. PII-local: absolute block, highest priority.
  if (policy.piiLocal) {
    return { allowed: false, reason: 'pii_local_blocked' }
  }
  // 2. The task-type must be a known L2 type at all.
  if (!isLayer2TaskType(taskType)) {
    return { allowed: false, reason: 'unknown_task_type' }
  }
  // 3. ... and within this agent's allowlist.
  if (!policy.allowedTaskTypes.includes(taskType)) {
    return { allowed: false, reason: 'task_type_not_allowed_for_agent' }
  }
  // 4. The content's sensitivity must not exceed the agent's egress ceiling.
  const sens = normalizeSensitivity(sensitivity)
  if (SENSITIVITY_RANK[sens] > SENSITIVITY_RANK[policy.maxEgressSensitivity]) {
    return { allowed: false, reason: 'sensitivity_exceeds_ceiling' }
  }
  return { allowed: true, reason: 'ok' }
}
