// Gmail label management for the Claudia Google MCP server (v2). Scope:
// gmail.labels. List / create / update label definitions are unguarded;
// gmail_delete_label is hard-guarded (ask-first) AND additionally refuses to
// touch Gmail system labels before any API call (edge case in the spec).
//
// Egress: this module talks ONLY to gmail.googleapis.com.
import type { FetchLike } from './google-oauth.js'

export const GMAIL_LABELS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/labels'

const realFetch = fetch as unknown as FetchLike

// Reserved Gmail system label ids. User labels are created with ids like
// "Label_<n>"; system labels use these fixed names plus the CATEGORY_* family.
// Deleting one is meaningless/destructive, so it is refused pre-API.
const SYSTEM_LABELS = new Set([
  'INBOX', 'SENT', 'TRASH', 'SPAM', 'DRAFT', 'UNREAD', 'STARRED',
  'IMPORTANT', 'CHAT',
])

export function isSystemLabel(id: string): boolean {
  return SYSTEM_LABELS.has(id) || id.startsWith('CATEGORY_')
}

export interface LabelDef {
  id: string
  name: string
  type?: string
}

export interface LabelCreate {
  name: string
  labelListVisibility?: string
  messageListVisibility?: string
  color?: { textColor?: string; backgroundColor?: string }
}

export interface LabelPatch {
  name?: string
  color?: { textColor?: string; backgroundColor?: string }
}

async function call(
  url: string,
  method: string,
  accessToken: string,
  body: unknown,
  fetchFn: FetchLike,
): Promise<any> {
  const init: any = { method, headers: { Authorization: `Bearer ${accessToken}` } }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetchFn(url, init)
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`gmail label ${method} failed: ${res.status} ${t.slice(0, 200)}`)
  }
  return res
}

export async function listLabels(
  accessToken: string,
  fetchFn: FetchLike = realFetch,
): Promise<{ labels: LabelDef[] }> {
  const res = await call(GMAIL_LABELS_URL, 'GET', accessToken, undefined, fetchFn)
  const j = (await res.json()) as { labels?: LabelDef[] }
  return { labels: j.labels ?? [] }
}

export async function createLabel(
  accessToken: string,
  def: LabelCreate,
  fetchFn: FetchLike = realFetch,
): Promise<LabelDef> {
  const res = await call(GMAIL_LABELS_URL, 'POST', accessToken, def, fetchFn)
  return (await res.json()) as LabelDef
}

export async function updateLabel(
  accessToken: string,
  id: string,
  patch: LabelPatch,
  fetchFn: FetchLike = realFetch,
): Promise<LabelDef> {
  const url = `${GMAIL_LABELS_URL}/${encodeURIComponent(id)}`
  const res = await call(url, 'PATCH', accessToken, patch, fetchFn)
  return (await res.json()) as LabelDef
}

// Delete a label definition (un-labels every message that carried it). Refuses
// system labels before any API call; the ask-first guard handles the human
// confirmation for user labels.
export async function deleteLabel(
  accessToken: string,
  id: string,
  fetchFn: FetchLike = realFetch,
): Promise<{ id: string } | { error: string }> {
  if (isSystemLabel(id)) return { error: 'system labels cannot be deleted' }
  const url = `${GMAIL_LABELS_URL}/${encodeURIComponent(id)}`
  await call(url, 'DELETE', accessToken, undefined, fetchFn)
  return { id }
}
