/**
 * POST /api/gmail/label-health -- Gmail custom-label count check (OPS-130, 5e6e0e55).
 *
 * The morning brief calls gmail_list_labels via MCP, then POSTs the label list here.
 * This endpoint counts custom labels (id starts with "Label_") and returns whether
 * the correct Gmail account is active.
 *
 * Problem: if the Gmail MCP is pointed at the wrong account (e.g. dub.thedubler),
 * there are 0 custom labels. The check runs daily so drift is caught within 1 day,
 * not 5.7 days as in the 2026-08 incident.
 *
 * Body: { labels: Array<{ id: string; name: string }> }
 * Response: { healthy: boolean; customLabelCount: number; systemLabelCount: number; reason: string }
 */
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export interface GmailLabel {
  id: string
  name: string
}

export interface LabelHealthResult {
  healthy: boolean
  customLabelCount: number
  systemLabelCount: number
  reason: string
}

// Gmail user-created labels have IDs starting with "Label_"
// System labels: INBOX, SENT, TRASH, SPAM, STARRED, IMPORTANT, CATEGORY_*, etc.
function isCustomLabel(label: GmailLabel): boolean {
  return label.id.startsWith('Label_')
}

/**
 * Pure decision: given a list of labels, returns health verdict.
 * 0 custom labels = wrong account (YELLOW alert).
 */
export function checkLabelHealth(labels: GmailLabel[]): LabelHealthResult {
  const custom = labels.filter(isCustomLabel)
  const system = labels.filter(l => !isCustomLabel(l))

  if (custom.length === 0) {
    return {
      healthy: false,
      customLabelCount: 0,
      systemLabelCount: system.length,
      reason: `0 custom labels -- likely wrong Gmail account (expected Label_* ids, got only system labels)`,
    }
  }

  return {
    healthy: true,
    customLabelCount: custom.length,
    systemLabelCount: system.length,
    reason: `ok: ${custom.length} custom label(s) found`,
  }
}

export async function tryHandleGmailLabelHealth(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/gmail/label-health' || method !== 'POST') return false

  let body: { labels?: GmailLabel[] }
  try {
    body = JSON.parse((await readBody(req)).toString())
  } catch {
    json(res, { error: 'invalid JSON' }, 400)
    return true
  }

  const labels = body.labels
  if (!Array.isArray(labels)) {
    json(res, { error: 'labels array required' }, 400)
    return true
  }

  json(res, checkLabelHealth(labels))
  return true
}
