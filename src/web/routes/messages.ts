import {
  createAgentMessage, getPendingMessages, listAgentMessages,
  getAgentConversation, getAgentConversationThreads,
  markMessageDone, markMessageFailed,
  type AgentMessage,
} from '../../db.js'
import { logger } from '../../logger.js'
import { COORDINATOR_AGENT_ID } from '../../channel-coordinator/ingest.js'
import { sanitizeAgentIdent } from '../../prompt-safety.js'
import { normalizeRecipient } from '../agent-config.js'
import { aiDefenceGuard, type Severity } from '../../aidefence-guard.js'
import { recordGuardEvent } from '../guard-event-recorder.js'
import { decideMessageFrom, enforceFromBindingEnabled, logFromMismatch } from '../agent-identity-binding.js'
import { readBody, json } from '../http-helpers.js'
import { DELEGATION_DEPTH_LIMIT } from '../../config.js'
import {
  deriveDelegationDepth, isDelegationDepthExceeded, escalateDelegationDepth,
  DELEGATION_DEPTH_EXCEEDED,
} from '../delegation-depth-guard.js'
import type { RouteContext } from './types.js'

export async function tryHandleMessages(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url, identity } = ctx

  if (path === '/api/messages' && method === 'POST') {
    const body = await readBody(req)
    // NOTE: delegation_depth is intentionally NOT destructured from the payload --
    // the server DERIVES it from the parent chain (anti-spoofing, card 3e80e203 /
    // §2.2). Only delegation_parent_id (a reference to the triggering inbound
    // message) is accepted from the client, and it is validated below.
    const { from, to, content, ack_expected, priority, in_reply_to, delegation_parent_id } = JSON.parse(body.toString()) as { from: string; to: string; content: string; ack_expected?: boolean; priority?: string; in_reply_to?: number; delegation_parent_id?: number }
    if (!from?.trim() || !to?.trim() || !content?.trim()) {
      json(res, { error: 'from, to, and content are required' }, 400)
      return true
    }
    // Optional escalation priority (card 28d2179f). Default 'normal'. Validate
    // against the enum here so a bad value is a clean 400, not a DB CHECK 500.
    const VALID_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
    if (priority !== undefined && !VALID_PRIORITIES.includes(priority as (typeof VALID_PRIORITIES)[number])) {
      json(res, { error: `priority must be one of ${VALID_PRIORITIES.join(', ')}` }, 400)
      return true
    }
    // Optional threading parent (card d4fe794f). When present it must be a
    // positive integer message id; reject anything else as a clean 400 rather
    // than letting a bad value reach the INSERT. null/undefined = unthreaded.
    if (in_reply_to !== undefined && in_reply_to !== null &&
        !(Number.isInteger(in_reply_to) && in_reply_to > 0)) {
      json(res, { error: 'in_reply_to must be a positive integer message id' }, 400)
      return true
    }
    // Delegation parent (card 3e80e203). When present it is the id of the TRIGGERING
    // inbound message; the server derives delegation_depth from it (never the client
    // value). Must be a positive integer; null/undefined = root (depth 0).
    if (delegation_parent_id !== undefined && delegation_parent_id !== null &&
        !(Number.isInteger(delegation_parent_id) && delegation_parent_id > 0)) {
      json(res, { error: 'delegation_parent_id must be a positive integer message id' }, 400)
      return true
    }
    // Security: the channel-coordinator id grants channel-inbound delivery
    // (verbatim <channel> + reply-expected framing) in the message-router. The
    // ONLY legitimate writer of that id is the in-process coordinator, which
    // inserts directly into the DB -- it never POSTs here. The dashboard token
    // is readable by every sub-agent, so without this guard any sub-agent could
    // forge a reply-expected message addressed at the main agent. Reject it.
    //
    // CRITICAL: normalize with the EXACT function the router matches on
    // (sanitizeAgentIdent), NOT from.trim(). The router does
    // CHANNEL_COORDINATOR_AGENTS.has(sanitizeAgentIdent(from)), and
    // sanitizeAgentIdent STRIPS [^a-zA-Z0-9_-] rather than trimming. A bypass
    // like from="@telegram-coordinator" / "telegram-coordinator." survives
    // .trim() (!= the constant) yet sanitizes to "telegram-coordinator" in the
    // router -> channel-inbound with an attacker-controlled body. Matching the
    // router's normalization here closes that asymmetry.
    if (sanitizeAgentIdent(from) === COORDINATOR_AGENT_ID) {
      logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST forging channel-coordinator id')
      json(res, { error: 'from is reserved for the in-process channel coordinator' }, 403)
      return true
    }
    // Detection-only mismatch log (card 38bff392, C-INTERIM): flag-INDEPENDENT.
    // Logs an impersonation-surface hit (a token sending as another agent) WITHOUT
    // blocking, so we gather evidence today while enforcement is still OFF. Reuses
    // the decideMessageFrom predicate internally -> never diverges from the C-BIND
    // enforcer and inherits the admin/operator-relay exclusion.
    logFromMismatch((line) => logger.warn(line), identity, from)
    // Identity binding (card b1ce5118 / db9bc192): the server DERIVES the effective
    // sender from the token-resolved identity rather than trusting the body. This
    // GENERALIZES the single-id coordinator guard above to every agent_id -- a
    // per-agent token may only send as itself; admin/operator may impersonate.
    // ENFORCE_FROM_BINDING defaults ON (C-BIND, db9bc192); only an explicit
    // ENFORCE_FROM_BINDING=false env-var disables it (non-provisioned environments).
    const fromDecision = decideMessageFrom(identity, from, enforceFromBindingEnabled())
    if (!fromDecision.ok) {
      logger.warn(
        { tokenAgent: identity.agentId, claimedFrom: from.trim(), to: to.trim() },
        'Rejected /api/messages POST: from does not match authenticated identity',
      )
      json(res, { error: fromDecision.error }, fromDecision.status)
      return true
    }
    const effectiveFrom = fromDecision.from.trim()
    let guard: ReturnType<typeof aiDefenceGuard>
    try {
      guard = aiDefenceGuard(effectiveFrom, content.trim())
    } catch (err) {
      logger.error({ err, from: effectiveFrom }, 'AIDefence: guard threw, fail-closed BLOCK')
      try {
        recordGuardEvent({
          mechanism: 'guard-error',
          route: '/api/messages',
          verdict: 'BLOCK',
          fromAgent: effectiveFrom,
          toAgent: to.trim(),
          patternIds: 'guard-error',
          maxSeverity: 'critical',
          findingCount: 1,
          content: content.trim(),
        })
      } catch { /* recorder failure non-fatal; guard already fail-CLOSED */ }
      json(res, { error: 'Message blocked: security guard error' }, 400)
      return true
    }
    // Persist every verdict (PASS included) so block-rate denominators survive
    // the 7-day agent_messages sweep. guard_events has its own 180-day retention.
    const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 }
    const maxSev = guard.findings.reduce<Severity | null>(
      (best, f) => best === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best] ? f.severity : best,
      null,
    )
    // Chad exemption (card 90c8c74b): Chad's security verdicts legitimately cite
    // injection-pattern examples as evidence, triggering false positives. Downgrade
    // BLOCK → FLAG when effectiveFrom === 'chad' AND from-binding is ON.
    // SAFETY: only effective with binding ON -- that's when identity is token-bound
    // and cannot be spoofed. With binding OFF, the exemption falls back to BLOCK.
    // CAVEAT: admin-scope can impersonate chad (within the trust model: admin can
    // disable the guard entirely; this does not expand the attack surface).
    const bindingActive = enforceFromBindingEnabled()
    const effectiveVerdict: typeof guard.verdict =
      guard.verdict === 'BLOCK' && effectiveFrom === 'chad' && bindingActive
        ? 'FLAG'
        : guard.verdict
    recordGuardEvent({
      mechanism: 'messages-guard',
      route: '/api/messages',
      verdict: effectiveVerdict,
      fromAgent: effectiveFrom,
      toAgent: to.trim(),
      patternIds: guard.findings.length > 0 ? [...new Set(guard.findings.map(f => f.pattern))].sort().join(',') : null,
      maxSeverity: maxSev,
      findingCount: guard.findings.length,
      content: content.trim(),
    })
    if (effectiveVerdict === 'BLOCK') {
      logger.warn(
        { from: effectiveFrom, to: to.trim(), findings: guard.findings },
        'AIDefence: message BLOCKED',
      )
      json(res, { error: 'Message blocked by AIDefence security guard', findings: guard.findings }, 400)
      return true
    }
    if (effectiveVerdict === 'FLAG') {
      logger.warn(
        { from: effectiveFrom, to: to.trim(), findings: guard.findings },
        'AIDefence: message FLAGGED (allowed through)',
      )
    }
    // Normalize the recipient before queueing. A message addressed to the tmux
    // SESSION name ("agent-dave") instead of the agent NAME ("dave") used to
    // queue, never match in the router, and silently vanish forever. Resolve
    // it to a known agent (stripping a single leading "agent-" prefix) or, if
    // it is still unknown, reject with a 400 instead of accepting an
    // undeliverable message.
    const recipient = normalizeRecipient(to)
    if (!recipient) {
      logger.warn({ from: effectiveFrom, to: to.trim() }, 'Rejected /api/messages POST: unknown recipient')
      json(res, { error: `Unknown recipient: ${to.trim()}` }, 400)
      return true
    }
    // Delegation loop/depth guard (card 3e80e203 / DA G-02). Derive the depth
    // SERVER-SIDE from the parent chain -- the client-supplied delegation_depth is
    // never read, so a deep chain cannot be masked by claiming depth 0. A root
    // (no parent) is depth 0; an unresolvable parent fails safe at the limit so a
    // runaway cycle still halts (assertion-direction, §2.2). On a limit hit the
    // insert is DECLINED and the Boss is escalated once (AC3/AC4).
    const { depth: delegationDepth, parentId: delegationParentId } =
      deriveDelegationDepth(delegation_parent_id ?? null)
    if (isDelegationDepthExceeded(delegationDepth)) {
      await escalateDelegationDepth({
        from: effectiveFrom, to: recipient, depth: delegationDepth,
        limit: DELEGATION_DEPTH_LIMIT, parentId: delegationParentId,
      })
      json(res, { error: DELEGATION_DEPTH_EXCEEDED, depth: delegationDepth, limit: DELEGATION_DEPTH_LIMIT }, 429)
      return true
    }
    const msg = createAgentMessage(effectiveFrom, recipient, content.trim(), ack_expected === true, (priority as AgentMessage['priority']) ?? 'normal', in_reply_to ?? null, delegationDepth, delegationParentId)
    logger.info({ id: msg.id, from: msg.from_agent, to: msg.to_agent, ackExpected: msg.ack_expected, priority: msg.priority, inReplyTo: msg.in_reply_to, delegationDepth: msg.delegation_depth, delegationParentId: msg.delegation_parent_id }, 'Agent message created')
    json(res, msg)
    return true
  }

  // Sidebar threads: one row per conversation peer (system agents excluded),
  // each with its count + most-recent message, recency computed per-peer.
  if (path === '/api/messages/threads' && method === 'GET') {
    json(res, getAgentConversationThreads())
    return true
  }

  if (path === '/api/messages' && method === 'GET') {
    const VALID_PARAMS = new Set(['agent', 'status', 'limit', 'before', 'from', 'to'])
    for (const key of url.searchParams.keys()) {
      if (!VALID_PARAMS.has(key)) {
        json(res, { error: `Unknown filter param: ${key}. Valid params: agent, status, limit, before, from, to` }, 400)
        return true
      }
    }
    const agent = url.searchParams.get('agent') || ''
    const status = url.searchParams.get('status') || ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
    const beforeRaw = url.searchParams.get('before')
    const before = beforeRaw !== null ? parseInt(beforeRaw, 10) : undefined

    let messages: AgentMessage[]
    if (status === 'pending' && agent) {
      messages = getPendingMessages(agent)
    } else if (status === 'pending') {
      messages = getPendingMessages()
    } else if (agent) {
      // SQL-filtered to THIS agent's last N (+ before-cursor pagination), not
      // global-last-N-then-JS-filter which starved rarely-active threads.
      messages = getAgentConversation(agent, limit, Number.isFinite(before as number) ? before : undefined)
    } else {
      messages = listAgentMessages(limit)
    }

    json(res, messages)
    return true
  }

  const msgUpdateMatch = path.match(/^\/api\/messages\/(\d+)$/)
  if (msgUpdateMatch && method === 'PUT') {
    const id = parseInt(msgUpdateMatch[1], 10)
    const body = await readBody(req)
    const { status: newStatus, result } = JSON.parse(body.toString()) as { status: string; result?: string }

    let ok = false
    if (newStatus === 'done') ok = markMessageDone(id, result)
    else if (newStatus === 'failed') ok = markMessageFailed(id, result)

    if (ok) { json(res, { ok: true }); return true }
    json(res, { error: 'Message not found or invalid status' }, 404)
    return true
  }

  return false
}
