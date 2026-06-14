// Gmail read for the Claudia Google MCP server (v2). Scope: gmail.modify (read
// side). Lists/searches messages and threads and reads full message bodies.
//
// SECURITY (SEC-AC1, STRIDE S1/S2): every piece of sender-controlled text that
// leaves googleapis -- message snippets and message bodies -- is wrapped via
// wrapUntrusted() BEFORE it is returned, so it enters Claudia's context as DATA,
// never as an instruction. Bodies are additionally reduced to plain text with a
// static stripper (no HTML renderer, no JS execution).
//
// PII (SEC-AC2): this module only RETURNS content to the caller. It never
// persists anything. The prohibition on writing body/snippet to memory / daily
// log / inter-agent lives at the call sites and in Claudia's CLAUDE.md.
//
// Egress: this module talks ONLY to gmail.googleapis.com.
import type { FetchLike } from './google-oauth.js'
import { wrapUntrusted } from './untrusted.js'

// The only host this module contacts. *.googleapis.com (Chad egress review).
export const GMAIL_MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'
export const GMAIL_THREADS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/threads'

const realFetch = fetch as unknown as FetchLike

// Default page size for list operations. Bounded so a list never floods context.
const DEFAULT_MAX_RESULTS = 20

export interface ListParams {
  q?: string
  maxResults?: number
}

export interface MessageMeta {
  id: string
  threadId: string
  subject: string
  from: string
  date: string
  snippet: string // untrusted-wrapped
}

export interface MessageFull {
  id: string
  threadId: string
  subject: string
  from: string
  to: string
  date: string
  body: string // untrusted-wrapped, HTML stripped to plain text
}

export interface ThreadMeta {
  id: string
  snippet: string // untrusted-wrapped
}

export interface NotFound {
  error: 'not found'
  id: string
}

type GmailHeader = { name?: string; value?: string }
type GmailPart = {
  mimeType?: string
  headers?: GmailHeader[]
  body?: { data?: string }
  parts?: GmailPart[]
}
type GmailMessage = {
  id?: string
  threadId?: string
  snippet?: string
  payload?: GmailPart
}

function authGet(url: string, accessToken: string, fetchFn: FetchLike) {
  return fetchFn(url, { headers: { Authorization: `Bearer ${accessToken}` } })
}

function header(payload: GmailPart | undefined, name: string): string {
  const h = (payload?.headers ?? []).find(
    (x) => (x.name ?? '').toLowerCase() === name.toLowerCase(),
  )
  return h?.value ?? ''
}

function decodeB64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8')
}

// Static, renderer-free HTML -> plain text. Drops <script>/<style> blocks
// entirely, strips remaining tags, decodes a small set of named/numeric
// entities, and collapses whitespace. No DOM, no JS execution (F-AC1 edge).
export function stripHtml(html: string): string {
  let s = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  // line-breaking tags become spaces so words don't fuse
  s = s.replace(/<(br|\/p|\/div|\/tr|\/li)\b[^>]*>/gi, ' ')
  s = s.replace(/<[^>]+>/g, '')
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  return s.replace(/\s+/g, ' ').trim()
}

// Extract the best plain-text body from a message payload: prefer a text/plain
// part, fall back to text/html (stripped). Walks nested multipart trees.
function extractBody(payload: GmailPart | undefined): string {
  if (!payload) return ''
  const plain = findPart(payload, 'text/plain')
  if (plain?.body?.data) return decodeB64Url(plain.body.data)
  const html = findPart(payload, 'text/html')
  if (html?.body?.data) return stripHtml(decodeB64Url(html.body.data))
  // single-part message: body sits directly on the payload
  if (payload.body?.data) {
    const raw = decodeB64Url(payload.body.data)
    return (payload.mimeType ?? '').toLowerCase() === 'text/html' ? stripHtml(raw) : raw
  }
  return ''
}

function findPart(payload: GmailPart, mime: string): GmailPart | undefined {
  if ((payload.mimeType ?? '').toLowerCase() === mime && payload.body?.data) return payload
  for (const p of payload.parts ?? []) {
    const found = findPart(p, mime)
    if (found) return found
  }
  return undefined
}

function toFull(m: GmailMessage): MessageFull {
  return {
    id: m.id ?? '',
    threadId: m.threadId ?? '',
    subject: header(m.payload, 'Subject'),
    from: header(m.payload, 'From'),
    to: header(m.payload, 'To'),
    date: header(m.payload, 'Date'),
    body: wrapUntrusted(extractBody(m.payload)),
  }
}

// List/search messages: returns id + metadata headers + untrusted-wrapped
// snippet (no body). 0 results -> {messages:[], total:0} (not an error).
export async function listMessages(
  accessToken: string,
  params: ListParams,
  fetchFn: FetchLike = realFetch,
): Promise<{ messages: MessageMeta[]; total: number }> {
  const url = new URL(GMAIL_MESSAGES_URL)
  if (params.q) url.searchParams.set('q', params.q)
  url.searchParams.set('maxResults', String(params.maxResults ?? DEFAULT_MAX_RESULTS))
  const res = await authGet(url.toString(), accessToken, fetchFn)
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`gmail list failed: ${res.status} ${t.slice(0, 200)}`)
  }
  const j = (await res.json()) as { messages?: { id: string; threadId: string }[] }
  const ids = j.messages ?? []
  if (ids.length === 0) return { messages: [], total: 0 }
  // Gmail's list returns ids only; fetch metadata (incl. snippet) per message.
  const metaUrl = (id: string) => {
    const u = new URL(`${GMAIL_MESSAGES_URL}/${encodeURIComponent(id)}`)
    u.searchParams.set('format', 'metadata')
    for (const h of ['Subject', 'From', 'Date']) u.searchParams.append('metadataHeaders', h)
    return u.toString()
  }
  const messages: MessageMeta[] = []
  for (const { id } of ids) {
    const r = await authGet(metaUrl(id), accessToken, fetchFn)
    if (!r.ok) continue // skip a message that vanished between list and get
    const m = (await r.json()) as GmailMessage
    messages.push({
      id: m.id ?? id,
      threadId: m.threadId ?? '',
      subject: header(m.payload, 'Subject'),
      from: header(m.payload, 'From'),
      date: header(m.payload, 'Date'),
      snippet: wrapUntrusted(m.snippet ?? ''),
    })
  }
  return { messages, total: messages.length }
}

// Read a full message: headers + plain-text body (untrusted-wrapped). Missing
// message -> {error:"not found", id} (no exception).
export async function getMessage(
  accessToken: string,
  id: string,
  fetchFn: FetchLike = realFetch,
): Promise<MessageFull | NotFound> {
  const url = new URL(`${GMAIL_MESSAGES_URL}/${encodeURIComponent(id)}`)
  url.searchParams.set('format', 'full')
  const res = await authGet(url.toString(), accessToken, fetchFn)
  if (!res.ok) {
    if (res.status === 404) return { error: 'not found', id }
    const t = await res.text().catch(() => '')
    throw new Error(`gmail get message failed: ${res.status} ${t.slice(0, 200)}`)
  }
  const m = (await res.json()) as GmailMessage
  return toFull(m)
}

// Read a full conversation thread: every message body untrusted-wrapped.
// Missing thread -> {error:"not found", id}.
export async function getThread(
  accessToken: string,
  id: string,
  fetchFn: FetchLike = realFetch,
): Promise<{ id: string; messages: MessageFull[] } | NotFound> {
  const url = new URL(`${GMAIL_THREADS_URL}/${encodeURIComponent(id)}`)
  url.searchParams.set('format', 'full')
  const res = await authGet(url.toString(), accessToken, fetchFn)
  if (!res.ok) {
    if (res.status === 404) return { error: 'not found', id }
    const t = await res.text().catch(() => '')
    throw new Error(`gmail get thread failed: ${res.status} ${t.slice(0, 200)}`)
  }
  const j = (await res.json()) as { id?: string; messages?: GmailMessage[] }
  return { id: j.id ?? id, messages: (j.messages ?? []).map(toFull) }
}

// List threads matching an optional query: id + untrusted-wrapped snippet (no
// bodies). 0 results -> {threads:[], total:0}.
export async function listThreads(
  accessToken: string,
  params: ListParams,
  fetchFn: FetchLike = realFetch,
): Promise<{ threads: ThreadMeta[]; total: number }> {
  const url = new URL(GMAIL_THREADS_URL)
  if (params.q) url.searchParams.set('q', params.q)
  url.searchParams.set('maxResults', String(params.maxResults ?? DEFAULT_MAX_RESULTS))
  const res = await authGet(url.toString(), accessToken, fetchFn)
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`gmail list threads failed: ${res.status} ${t.slice(0, 200)}`)
  }
  const j = (await res.json()) as { threads?: { id: string; snippet?: string }[] }
  const threads = (j.threads ?? []).map((t) => ({
    id: t.id,
    snippet: wrapUntrusted(t.snippet ?? ''),
  }))
  return { threads, total: threads.length }
}
