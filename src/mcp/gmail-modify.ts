// Gmail modify-write for the Claudia Google MCP server (v2). Scope: gmail.modify.
// Reversible label operations (archive / mark-read / star / label / spam /
// move-to-inbox) plus the single guarded irreversible-ish op (trash, 30-day
// recoverable, ask-first via GUARDED_TOOLS).
//
// SEC-AC6 -- bulk threshold: the multi-message path (batchModify) rejects any
// batch larger than BULK_MODIFY_LIMIT BEFORE making an API call. The limit is a
// hardcoded server constant, never a caller parameter.
//
// Egress: this module talks ONLY to gmail.googleapis.com (URLs derived from
// GMAIL_MESSAGES_URL).
import type { FetchLike } from './google-oauth.js'
import { GMAIL_MESSAGES_URL } from './gmail-messages.js'

const realFetch = fetch as unknown as FetchLike

// Bulk-modify ceiling (SEC-AC6). Constant, not a parameter.
export const BULK_MODIFY_LIMIT = 10

// Gmail system label ids used by the label deltas.
export const LBL_INBOX = 'INBOX'
export const LBL_UNREAD = 'UNREAD'
export const LBL_STARRED = 'STARRED'
export const LBL_SPAM = 'SPAM'
export const LBL_TRASH = 'TRASH'

export interface LabelChange {
  add?: string[]
  remove?: string[]
}

// --- pure label deltas (one per user-facing operation) ---
export function archiveDelta(): LabelChange {
  return { remove: [LBL_INBOX] }
}
export function markReadDelta(read: boolean): LabelChange {
  return read ? { remove: [LBL_UNREAD] } : { add: [LBL_UNREAD] }
}
export function starDelta(starred: boolean): LabelChange {
  return starred ? { add: [LBL_STARRED] } : { remove: [LBL_STARRED] }
}
export function labelDelta(labelId: string, apply: boolean): LabelChange {
  return apply ? { add: [labelId] } : { remove: [labelId] }
}
export function spamDelta(): LabelChange {
  return { add: [LBL_SPAM], remove: [LBL_INBOX] }
}
export function unspamDelta(): LabelChange {
  return { add: [LBL_INBOX], remove: [LBL_SPAM] }
}

function modifyBody(change: LabelChange): Record<string, string[]> {
  const body: Record<string, string[]> = {}
  if (change.add?.length) body.addLabelIds = change.add
  if (change.remove?.length) body.removeLabelIds = change.remove
  return body
}

async function post(
  url: string,
  accessToken: string,
  body: unknown,
  fetchFn: FetchLike,
): Promise<any> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`gmail modify failed: ${res.status} ${t.slice(0, 200)}`)
  }
  return res
}

// Apply a label delta to one or more messages. Single id -> messages/{id}/modify;
// multiple -> messages/batchModify (guarded by BULK_MODIFY_LIMIT, pre-fetch).
export async function applyToMessages(
  accessToken: string,
  ids: string[],
  change: LabelChange,
  fetchFn: FetchLike = realFetch,
): Promise<{ ids: string[] }> {
  if (!ids || ids.length === 0) throw new Error('gmail modify: no messages given')
  if (ids.length > BULK_MODIFY_LIMIT) {
    throw new Error(
      `bulk modify rejected: ${ids.length} messages exceeds the limit of ${BULK_MODIFY_LIMIT}`,
    )
  }
  if (ids.length === 1) {
    const url = `${GMAIL_MESSAGES_URL}/${encodeURIComponent(ids[0])}/modify`
    await post(url, accessToken, modifyBody(change), fetchFn)
    return { ids }
  }
  const url = `${GMAIL_MESSAGES_URL}/batchModify`
  await post(url, accessToken, { ids, ...modifyBody(change) }, fetchFn)
  return { ids }
}

// Move a message to Trash (30-day recoverable). Single message only -- this is a
// hard-guarded tool (GUARDED_TOOLS / ask-first); never batched.
export async function trashMessage(
  accessToken: string,
  id: string,
  fetchFn: FetchLike = realFetch,
): Promise<{ id: string }> {
  const url = `${GMAIL_MESSAGES_URL}/${encodeURIComponent(id)}/trash`
  await post(url, accessToken, undefined, fetchFn)
  return { id }
}

// Restore a message from Trash or Spam to the inbox. Untrash (dedicated endpoint
// -- Gmail won't drop the TRASH label via modify), then re-add INBOX and clear
// SPAM in one modify.
export async function moveToInbox(
  accessToken: string,
  id: string,
  fetchFn: FetchLike = realFetch,
): Promise<{ id: string }> {
  await post(`${GMAIL_MESSAGES_URL}/${encodeURIComponent(id)}/untrash`, accessToken, undefined, fetchFn)
  await post(`${GMAIL_MESSAGES_URL}/${encodeURIComponent(id)}/modify`, accessToken, {
    addLabelIds: [LBL_INBOX],
    removeLabelIds: [LBL_SPAM],
  }, fetchFn)
  return { id }
}
