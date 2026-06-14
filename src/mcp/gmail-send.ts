// Gmail send for the Claudia Google MCP server. Scope: gmail.send ONLY (no inbox
// read). The send tool is the ask-first-guarded tool: Claudia can never send
// without an explicit human approval (see scripts/hooks/guardrail-ask-first.py).
//
// Egress: this module talks ONLY to gmail.googleapis.com (see GMAIL_SEND_URL).
import type { FetchLike } from './google-oauth.js'

// The only host this module contacts. *.googleapis.com (Chad egress review).
export const GMAIL_SEND_URL =
  'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

const realFetch = fetch as unknown as FetchLike

export interface EmailDraft {
  to: string
  subject: string
  body: string
  cc?: string
  from?: string
}

// Strip CR/LF and other C0 control chars from a header VALUE before it is placed
// into the message, then collapse whitespace runs and trim. This blocks CRLF
// header injection (a value like "a@b.com\r\nBcc: evil@x.com" would otherwise
// smuggle an extra header). Chad gate PR #144 [medium]. Body is NOT sanitized:
// it legitimately contains newlines and sits after the header/body separator,
// so it cannot inject headers.
function sanitizeHeader(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/ +/g, ' ').trim()
}

// RFC 2047 encoded-word for a non-ASCII header value; ASCII passes through.
function encodeHeader(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(s)) return s
  return `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=`
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Build an RFC 5322 message and base64url-encode it for the Gmail API `raw` field.
export function buildRawMessage(d: EmailDraft): string {
  const to = sanitizeHeader(d.to ?? '')
  if (!to) throw new Error('gmail send: "to" is required')
  const from = d.from ? sanitizeHeader(d.from) : ''
  const cc = d.cc ? sanitizeHeader(d.cc) : ''
  const headers: string[] = []
  if (from) headers.push(`From: ${from}`)
  headers.push(`To: ${to}`)
  if (cc) headers.push(`Cc: ${cc}`)
  headers.push(`Subject: ${encodeHeader(sanitizeHeader(d.subject ?? ''))}`)
  headers.push('MIME-Version: 1.0')
  headers.push('Content-Type: text/plain; charset="UTF-8"')
  headers.push('Content-Transfer-Encoding: 8bit')
  const msg = headers.join('\r\n') + '\r\n\r\n' + (d.body ?? '')
  return base64url(Buffer.from(msg, 'utf-8'))
}

// POST a pre-built raw message to the Gmail send endpoint. Returns the sent
// message id.
export async function sendEmail(
  accessToken: string,
  raw: string,
  fetchFn: FetchLike = realFetch,
): Promise<string> {
  const res = await fetchFn(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`gmail send failed: ${res.status} ${t.slice(0, 200)}`)
  }
  const j = (await res.json()) as { id?: string }
  if (!j.id) throw new Error('gmail send: no message id in response')
  return j.id
}
