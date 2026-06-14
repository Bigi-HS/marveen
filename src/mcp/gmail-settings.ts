// Gmail filters + vacation settings for the Claudia Google MCP server (v2).
// Scope: gmail.settings.basic. list_filters / get_vacation are unguarded reads;
// create_filter, delete_filter and update_vacation are hard-guarded (ask-first).
//
// Forwarding (F-AC5 edge): a filter that sets a forwarding address needs
// gmail.settings.sharing, which is DELIBERATELY out of scope (SEC-AC3). Such a
// create therefore fails at the API with 403; we surface that as a clear error
// rather than letting it pass silently.
//
// Egress: this module talks ONLY to gmail.googleapis.com.
import type { FetchLike } from './google-oauth.js'

export const GMAIL_FILTERS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/filters'
export const GMAIL_VACATION_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation'

const realFetch = fetch as unknown as FetchLike

export interface FilterCriteria {
  from?: string
  to?: string
  subject?: string
  query?: string
  hasAttachment?: boolean
}
export interface FilterAction {
  addLabelIds?: string[]
  removeLabelIds?: string[]
  forward?: string
}
export interface FilterDef {
  id?: string
  criteria?: FilterCriteria
  action?: FilterAction
}

export interface VacationSettings {
  enableAutoReply: boolean
  responseSubject?: string
  responseBodyPlainText?: string
  restrictToContacts?: boolean
  startTime?: string
  endTime?: string
}

async function call(
  url: string,
  method: string,
  accessToken: string,
  body: unknown,
  fetchFn: FetchLike,
): Promise<Response> {
  const init: any = { method, headers: { Authorization: `Bearer ${accessToken}` } }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return (await fetchFn(url, init)) as unknown as Response
}

function throwHttp(label: string, status: number, text: string): never {
  throw new Error(`${label} failed: ${status} ${text.slice(0, 200)}`)
}

export async function listFilters(
  accessToken: string,
  fetchFn: FetchLike = realFetch,
): Promise<{ filters: FilterDef[] }> {
  const res = await call(GMAIL_FILTERS_URL, 'GET', accessToken, undefined, fetchFn)
  if (!res.ok) throwHttp('gmail list filters', res.status, await res.text().catch(() => ''))
  const j = (await res.json()) as { filter?: FilterDef[] }
  return { filters: j.filter ?? [] }
}

// Create a filter. A forwarding action 403s (scope absent) -> friendly error.
export async function createFilter(
  accessToken: string,
  def: { criteria: FilterCriteria; action: FilterAction },
  fetchFn: FetchLike = realFetch,
): Promise<{ id: string } | { error: string }> {
  const res = await call(GMAIL_FILTERS_URL, 'POST', accessToken, def, fetchFn)
  if (!res.ok) {
    if (res.status === 403) return { error: 'forwarding not enabled by scope' }
    throwHttp('gmail create filter', res.status, await res.text().catch(() => ''))
  }
  const j = (await res.json()) as { id?: string }
  return { id: j.id ?? '' }
}

export async function deleteFilter(
  accessToken: string,
  id: string,
  fetchFn: FetchLike = realFetch,
): Promise<{ id: string }> {
  const url = `${GMAIL_FILTERS_URL}/${encodeURIComponent(id)}`
  const res = await call(url, 'DELETE', accessToken, undefined, fetchFn)
  if (!res.ok) throwHttp('gmail delete filter', res.status, await res.text().catch(() => ''))
  return { id }
}

export async function getVacation(
  accessToken: string,
  fetchFn: FetchLike = realFetch,
): Promise<VacationSettings> {
  const res = await call(GMAIL_VACATION_URL, 'GET', accessToken, undefined, fetchFn)
  if (!res.ok) throwHttp('gmail get vacation', res.status, await res.text().catch(() => ''))
  return (await res.json()) as VacationSettings
}

// Set or clear the vacation auto-reply. Hard-guarded (ask-first).
export async function updateVacation(
  accessToken: string,
  settings: VacationSettings,
  fetchFn: FetchLike = realFetch,
): Promise<VacationSettings> {
  const res = await call(GMAIL_VACATION_URL, 'PUT', accessToken, settings, fetchFn)
  if (!res.ok) throwHttp('gmail update vacation', res.status, await res.text().catch(() => ''))
  return (await res.json()) as VacationSettings
}
