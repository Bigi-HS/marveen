// Operator action-layer routes: nudge an agent or run a skill on it, from the
// dashboard. Both inject a prompt into the target agent's live tmux session via
// action-trigger.ts, which wraps the operator's free text as untrusted data
// (Boss-accepted prompt-injection-into-session model, 2026-06-15). Bearer-gated
// by the dispatcher; this module adds input validation + the busy/offline
// surfacing so the UI can tell the operator why a trigger did not land.

import { MAIN_AGENT_ID } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { listAgentNames } from '../agent-config.js'
import { hasScope, ADMIN_SCOPE } from '../agent-token-registry.js'
import {
  composeNudgePrompt,
  composeSkillPrompt,
  isValidSkillName,
  injectToAgent,
  interruptAgent,
  type TriggerStatus,
} from '../action-trigger.js'
import type { RouteContext } from './types.js'

// Cap operator free text so a runaway paste can't be streamed key-by-key into a
// pane. Generous for a nudge/note, far below the scheduled-task prompt cap.
const MAX_NUDGE_LEN = 4000
const MAX_NOTE_LEN = 2000

function isKnownAgent(name: string): boolean {
  return name === MAIN_AGENT_ID || listAgentNames().includes(name)
}

// Map an inject outcome onto an HTTP response. `fired` -> 200; a live-but-busy
// pane -> 409 (retry or force); a dead session -> 503.
function respondForStatus(res: RouteContext['res'], status: TriggerStatus, agent: string): void {
  if (status === 'offline') {
    json(res, { error: `Agent "${agent}" session is not running`, status }, 503)
    return
  }
  if (status === 'busy') {
    json(res, { error: `Agent "${agent}" is busy; retry or use force`, status }, 409)
    return
  }
  json(res, { ok: true, status, agent })
}

export async function tryHandleAgentActions(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, identity } = ctx

  // Admin-scope gate (SEC: shared-bearer forgeable-actor, card 109e3c4d).
  // Every route here injects a prompt into / interrupts another agent's live
  // tmux pane -- a control-plane write. The dispatcher only proves the caller
  // holds *a* valid dashboard bearer; since the shared token is readable by
  // every sub-agent, that alone is forgeable (any per-agent token could drive
  // any other agent's pane). Authorize on the token-resolved identity instead.
  // Checked BEFORE isKnownAgent so the 404/403 split can't be used as an
  // agent-existence oracle, and uses the strict `hasScope(identity?.scopes, ...)`
  // shape (undefined identity -> false -> fail-CLOSED), never the `identity &&`
  // fail-OPEN form. GET verbs are not handled by this module.
  const isAgentActionRoute =
    method === 'POST' &&
    (/^\/api\/agents\/[^/]+\/(?:nudge|run-skill|interrupt)$/.test(path))
  if (isAgentActionRoute && !hasScope(identity?.scopes, ADMIN_SCOPE)) {
    json(res, { error: 'Forbidden: admin scope required' }, 403)
    return true
  }

  const nudgeMatch = path.match(/^\/api\/agents\/([^/]+)\/nudge$/)
  if (nudgeMatch && method === 'POST') {
    const agent = decodeURIComponent(nudgeMatch[1])
    if (!isKnownAgent(agent)) { json(res, { error: 'Unknown agent' }, 404); return true }

    const body = await readBody(req, { maxBytes: 64 * 1024 })
    const data = JSON.parse(body.toString()) as { text?: string; force?: boolean }
    const text = (data.text || '').trim()
    if (!text) { json(res, { error: 'text is required' }, 400); return true }
    if (text.length > MAX_NUDGE_LEN) {
      json(res, { error: `text too long (max ${MAX_NUDGE_LEN} chars)` }, 413)
      return true
    }

    const status = injectToAgent(agent, composeNudgePrompt(text), { force: data.force === true })
    logger.info({ agent, force: data.force === true, status }, 'Operator nudge')
    respondForStatus(res, status, agent)
    return true
  }

  const runSkillMatch = path.match(/^\/api\/agents\/([^/]+)\/run-skill$/)
  if (runSkillMatch && method === 'POST') {
    const agent = decodeURIComponent(runSkillMatch[1])
    if (!isKnownAgent(agent)) { json(res, { error: 'Unknown agent' }, 404); return true }

    const body = await readBody(req, { maxBytes: 64 * 1024 })
    const data = JSON.parse(body.toString()) as { skill?: string; note?: string; force?: boolean }
    const skill = (data.skill || '').trim()
    if (!skill) { json(res, { error: 'skill is required' }, 400); return true }
    if (!isValidSkillName(skill)) {
      json(res, { error: 'Invalid skill name (expected a kebab id, optionally plugin:skill)' }, 400)
      return true
    }
    const note = (data.note || '').trim()
    if (note.length > MAX_NOTE_LEN) {
      json(res, { error: `note too long (max ${MAX_NOTE_LEN} chars)` }, 413)
      return true
    }

    const status = injectToAgent(agent, composeSkillPrompt(skill, note || undefined), { force: data.force === true })
    logger.info({ agent, skill, force: data.force === true, status }, 'Operator run-skill')
    respondForStatus(res, status, agent)
    return true
  }

  // Soft-interrupt: send Escape into the agent's pane to cancel its current
  // turn -- the gentle rung between a nudge and a kill+restart. No body: this is
  // a pure control verb, nothing operator-supplied reaches the pane (only the
  // fixed cancel key), so there is no untrusted text to validate. `force` is
  // meaningless here -- interrupting a busy pane is the whole point.
  const interruptMatch = path.match(/^\/api\/agents\/([^/]+)\/interrupt$/)
  if (interruptMatch && method === 'POST') {
    const agent = decodeURIComponent(interruptMatch[1])
    if (!isKnownAgent(agent)) { json(res, { error: 'Unknown agent' }, 404); return true }

    const status = interruptAgent(agent)
    logger.info({ agent, status }, 'Operator interrupt')
    respondForStatus(res, status, agent)
    return true
  }

  return false
}
