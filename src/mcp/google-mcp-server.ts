#!/usr/bin/env node
// Claudia Google MCP server (stdio). Wires Claudia's full Google PA capability
// into her Claude Code session, backed by its own minimal-scope OAuth token:
//   v1: calendar_today (read) + gmail_send (ask-first GUARDED)
//   v2 (card 3a95349f): full Gmail (read / triage / labels / filters / vacation)
//       and full Calendar (read any range / create / update / delete).
//
// This is a LOCAL stdio server (like the Telegram MCP), independent of the
// claude.ai account-connector AND the env OAuth token, so it is immune to
// connector-masking. Egress is restricted to *.googleapis.com (see the URL
// constants in the sibling modules). The refresh token is loaded from
// GOOGLE_CHANNEL_DIR/oauth-tokens.json (0600, gitignored).
//
// Security wiring (v2):
//   - SEC-AC1: gmail read handlers return body/snippet already wrapped in
//     <untrusted source="gmail">; calendar free-text is wrapped here as
//     <untrusted source="calendar"> (defense-in-depth) before it enters context.
//   - SEC-AC4: every state-changing tool appends a metadata-only line to
//     mcp-audit.log; the audit dir is asserted at boot (fail-loud).
//   - SEC-AC2: audit summaries are ids / label-names / dates / booleans only --
//     never email body/snippet or event title/description.
//   - SEC-AC5: the 7 catastrophic ops are flagged `guarded` here AND gated by the
//     PreToolUse ask-first hook (which has already approved by the time a handler
//     runs); the server just executes + audits.
//   - SEC-AC6: bulk message ops reject >10 ids before any API call.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { readFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { AccessTokenProvider, loadGoogleCreds, type FetchLike } from './google-oauth.js'
import { listTodayEvents, type CalendarEvent } from './google-calendar.js'
import {
  driveListFiles,
  driveDownloadFile,
  driveUploadFile,
  driveGetMeta,
  backupDriveFileVersion,
  type DriveFetch,
  type DriveFileMeta,
} from './google-drive.js'
import { buildRawMessage, sendEmail } from './gmail-send.js'
import { listMessages, getMessage, getThread, listThreads } from './gmail-messages.js'
import {
  applyToMessages,
  trashMessage,
  moveToInbox,
  archiveDelta,
  markReadDelta,
  starDelta,
  labelDelta,
  spamDelta,
  unspamDelta,
} from './gmail-modify.js'
import { listLabels, createLabel, updateLabel, deleteLabel } from './gmail-labels.js'
import { listFilters, createFilter, deleteFilter, getVacation, updateVacation } from './gmail-settings.js'
import {
  listCalendars,
  listEvents,
  searchEvents,
  createEvent,
  updateEvent,
  updateEventAll,
  deleteEvent,
  type CalendarEventFull,
} from './calendar-events.js'
import { wrapUntrusted } from './untrusted.js'
import { appendAudit, assertAuditDir } from './audit-log.js'
import {
  SERVER_KEY,
  TOOL_CALENDAR_TODAY,
  TOOL_GMAIL_SEND,
  TOOL_GMAIL_LIST_MESSAGES,
  TOOL_GMAIL_GET_MESSAGE,
  TOOL_GMAIL_GET_THREAD,
  TOOL_GMAIL_LIST_THREADS,
  TOOL_GMAIL_ARCHIVE_MESSAGE,
  TOOL_GMAIL_MARK_READ,
  TOOL_GMAIL_STAR_MESSAGE,
  TOOL_GMAIL_LABEL_MESSAGE,
  TOOL_GMAIL_MOVE_TO_INBOX,
  TOOL_GMAIL_MARK_SPAM,
  TOOL_GMAIL_UNMARK_SPAM,
  TOOL_GMAIL_TRASH_MESSAGE,
  TOOL_GMAIL_LIST_LABELS,
  TOOL_GMAIL_CREATE_LABEL,
  TOOL_GMAIL_UPDATE_LABEL,
  TOOL_GMAIL_DELETE_LABEL,
  TOOL_GMAIL_LIST_FILTERS,
  TOOL_GMAIL_CREATE_FILTER,
  TOOL_GMAIL_DELETE_FILTER,
  TOOL_GMAIL_GET_VACATION,
  TOOL_GMAIL_UPDATE_VACATION,
  TOOL_CALENDAR_LIST_CALENDARS,
  TOOL_CALENDAR_LIST_EVENTS,
  TOOL_CALENDAR_SEARCH_EVENTS,
  TOOL_CALENDAR_CREATE_EVENT,
  TOOL_CALENDAR_UPDATE_EVENT,
  TOOL_CALENDAR_UPDATE_EVENT_ALL,
  TOOL_CALENDAR_DELETE_EVENT,
  TOOL_DRIVE_LIST_FILES,
  TOOL_DRIVE_DOWNLOAD_FILE,
  TOOL_DRIVE_UPLOAD_FILE,
} from './tool-names.js'

// Where the OAuth creds + refresh token live. Passed explicitly via the .mcp.json
// `env` so the server binary stays path-agnostic.
const CHANNEL_DIR = process.env.GOOGLE_CHANNEL_DIR ?? ''

// ENG-048: local pre-write Drive-backup dir (NOT on the Boss's Drive quota).
// Default is the repo `store/claudia-drive-backups`; overridable via env so the
// c12 sandbox / tests can point it elsewhere. The 6-month purge script cleans it.
const DRIVE_BACKUP_DIR =
  process.env.CLAUDIA_DRIVE_BACKUP_DIR ??
  join(process.cwd(), 'store', 'claudia-drive-backups')

// Lazily build the token provider on first tool use, so the server can start
// (and advertise its tools) even before the token file exists; only the actual
// call fails, with a clear message.
let provider: AccessTokenProvider | null = null
async function defaultGetToken(): Promise<string> {
  if (!provider) {
    if (!CHANNEL_DIR) {
      throw new Error('GOOGLE_CHANNEL_DIR env is not set (point it at the channels/google dir)')
    }
    const creds = await loadGoogleCreds(CHANNEL_DIR)
    provider = new AccessTokenProvider(creds)
  }
  return provider.get()
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}
function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2))
}

function formatEvent(e: CalendarEvent): string {
  const when = e.allDay ? `${e.start} (all day)` : `${e.start} - ${e.end}`
  const loc = e.location ? ` @ ${e.location}` : ''
  return `- ${when}: ${e.summary}${loc}`
}

// Wrap an event's attacker-influenceable free-text (external invites) before it
// enters Claudia's context. Times/ids/attendee emails are left as-is.
function wrapEvent(e: CalendarEventFull): CalendarEventFull {
  return {
    ...e,
    summary: e.summary != null ? wrapUntrusted(e.summary, 'calendar') : e.summary,
    description: e.description != null ? wrapUntrusted(e.description, 'calendar') : e.description,
    location: e.location != null ? wrapUntrusted(e.location, 'calendar') : e.location,
  }
}

// Read results are rendered as TEXT, not JSON: the untrusted wrapper must reach
// Claudia's context LITERALLY (`<untrusted source="gmail">...`) -- JSON.stringify
// would escape the quotes and defeat the SEC-AC1 boundary. The snippet/body/event
// fields below are already wrapped by their handlers, so they appear verbatim.
function fmtMessageList(r: { messages: any[]; total: number }): string {
  if (r.total === 0) return 'No messages.'
  return (
    `${r.total} message(s):\n` +
    r.messages
      .map((m) => `• [${m.id}] ${m.subject}\n  from: ${m.from}  date: ${m.date}\n  snippet: ${m.snippet}`)
      .join('\n')
  )
}
function fmtMessageFull(r: any): string {
  if ('error' in r) return `Error: ${r.error} (id ${r.id})`
  return `Subject: ${r.subject}\nFrom: ${r.from}\nTo: ${r.to}\nDate: ${r.date}\n\n${r.body}`
}
function fmtThread(r: any): string {
  if ('error' in r) return `Error: ${r.error} (id ${r.id})`
  return (
    `Thread ${r.id} (${r.messages.length} message(s)):\n\n` +
    r.messages.map((m: any) => `--- ${m.from} | ${m.date} ---\n${m.body}`).join('\n\n')
  )
}
function fmtThreadList(r: { threads: any[]; total: number }): string {
  if (r.total === 0) return 'No threads.'
  return `${r.total} thread(s):\n` + r.threads.map((t) => `• [${t.id}] ${t.snippet}`).join('\n')
}
function fmtEvent(e: CalendarEventFull): string {
  const when = e.start?.dateTime ?? e.start?.date ?? '?'
  const loc = e.location ? ` @ ${e.location}` : ''
  const desc = e.description ? `\n  ${e.description}` : ''
  return `• [${e.id ?? ''}] ${when}: ${e.summary ?? '(no title)'}${loc}${desc}`
}
function fmtEvents(events: CalendarEventFull[]): string {
  if (events.length === 0) return 'No events.'
  return events.map((e) => fmtEvent(wrapEvent(e))).join('\n')
}

// ENG-048: Drive file names are sharer-controllable -> untrusted-wrapped, like
// gmail/calendar free-text. Rendered as TEXT (not JSON) so the wrapper reaches
// Claudia's context literally.
function fmtDriveList(files: DriveFileMeta[]): string {
  if (files.length === 0) return 'No files.'
  return (
    `${files.length} file(s):\n` +
    files
      .map(
        (fl) =>
          `• [${fl.id}] ${wrapUntrusted(fl.name ?? '', 'drive')}` +
          `  (${fl.mimeType ?? '?'}${fl.size ? `, ${fl.size}B` : ''}${fl.modifiedTime ? `, ${fl.modifiedTime}` : ''})`,
      )
      .join('\n')
  )
}

// SEC (Chad PR#453 FLAG): confine a caller-supplied local path to a sandbox
// root, blocking path-traversal (absolute paths, `../` escapes). The Drive
// download/upload tools are NOT ask-first for the read side and Claudia's input
// can be prompt-injected, so an unconfined destPath could clobber arbitrary
// local files (e.g. ~/.claude/settings.json) and an unconfined srcPath could
// exfiltrate secrets (e.g. the channel's own oauth-tokens.json) to Drive.
// Roots are dedicated SUBDIRS of the channel dir (never the channel dir itself,
// which holds oauth-tokens.json + the audit log).
export function confineToRoot(root: string, candidate: string): string {
  const base = resolve(root)
  const p = resolve(base, candidate)
  if (p !== base && !p.startsWith(base + sep)) {
    throw new Error(`path escapes sandbox: "${candidate}" is outside ${root}`)
  }
  return p
}

export interface ToolDeps {
  getToken: () => Promise<string>
  channelDir: string
  now: () => number
  // Injectable for tests; undefined -> the handler modules use the real fetch.
  fetchFn?: FetchLike
  // ENG-048: local pre-write Drive-backup dir (host disk, off-quota). Optional
  // at the deps boundary; buildToolDefs falls back to DRIVE_BACKUP_DIR.
  driveBackupDir?: string
}

export interface ToolDef {
  name: string
  description: string
  inputSchema: z.ZodRawShape
  handler: (args: any) => Promise<{ content: { type: 'text'; text: string }[] }>
  guarded: boolean
  write: boolean
}

// zod fragments
const eventTime = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
})
const eventInputShape = {
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: eventTime.optional(),
  end: eventTime.optional(),
}

// Build the full tool registry. Pure given its deps -- unit-tested directly.
export function buildToolDefs(deps: ToolDeps): ToolDef[] {
  const f = deps.fetchFn
  // Drive needs a richer fetch (binary arrayBuffer response). The real global
  // fetch and the test stubs both satisfy DriveFetch; undefined -> the drive
  // module falls back to the real global fetch.
  const df = deps.fetchFn as unknown as DriveFetch | undefined
  const driveBackupDir = deps.driveBackupDir ?? DRIVE_BACKUP_DIR
  const audit = (tool: string, summary: string) =>
    appendAudit(deps.channelDir, deps.now(), tool, summary)
  const tok = deps.getToken

  return [
    // --- v1 (unchanged behaviour) ---
    {
      name: TOOL_CALENDAR_TODAY,
      description: "List today's Google Calendar events (Europe/Budapest, primary calendar). Read-only.",
      inputSchema: {},
      guarded: false,
      write: false,
      handler: async () => {
        const events = await listTodayEvents(await tok(), deps.now(), f)
        return textResult(events.length === 0 ? 'No events today.' : events.map(formatEvent).join('\n'))
      },
    },
    {
      name: TOOL_GMAIL_SEND,
      description:
        'Send an email via Gmail (scope gmail.send). ASK-FIRST GUARDED: irreversible external action, requires explicit human approval.',
      inputSchema: {
        to: z.string().describe('recipient email address'),
        subject: z.string().describe('email subject'),
        body: z.string().describe('plain-text email body'),
        cc: z.string().optional().describe('optional Cc address'),
      },
      guarded: true,
      write: true,
      handler: async ({ to, subject, body, cc }) => {
        const raw = buildRawMessage({ to, subject, body, cc })
        const id = await sendEmail(await tok(), raw, f)
        audit(TOOL_GMAIL_SEND, `to=${to} id=${id}`)
        return textResult(`Sent. Gmail message id: ${id}`)
      },
    },

    // --- Gmail read (gmail.modify) ---
    {
      name: TOOL_GMAIL_LIST_MESSAGES,
      description: 'List/search Gmail messages (optional query q). Returns id + metadata + untrusted-wrapped snippet, no body.',
      inputSchema: { q: z.string().optional(), maxResults: z.number().optional() },
      guarded: false,
      write: false,
      handler: async ({ q, maxResults }) => textResult(fmtMessageList(await listMessages(await tok(), { q, maxResults }, f))),
    },
    {
      name: TOOL_GMAIL_GET_MESSAGE,
      description: 'Read a full Gmail message (headers + plain-text body, HTML stripped, untrusted-wrapped).',
      inputSchema: { id: z.string() },
      guarded: false,
      write: false,
      handler: async ({ id }) => textResult(fmtMessageFull(await getMessage(await tok(), id, f))),
    },
    {
      name: TOOL_GMAIL_GET_THREAD,
      description: 'Read a full Gmail conversation thread (every message body untrusted-wrapped).',
      inputSchema: { id: z.string() },
      guarded: false,
      write: false,
      handler: async ({ id }) => textResult(fmtThread(await getThread(await tok(), id, f))),
    },
    {
      name: TOOL_GMAIL_LIST_THREADS,
      description: 'List Gmail threads (optional query q). Returns id + untrusted-wrapped snippet, no bodies.',
      inputSchema: { q: z.string().optional(), maxResults: z.number().optional() },
      guarded: false,
      write: false,
      handler: async ({ q, maxResults }) => textResult(fmtThreadList(await listThreads(await tok(), { q, maxResults }, f))),
    },

    // --- Gmail modify-write (gmail.modify) ---
    {
      name: TOOL_GMAIL_ARCHIVE_MESSAGE,
      description: 'Archive one or more messages (remove INBOX). Reversible. Batch limited to 10.',
      inputSchema: { ids: z.array(z.string()) },
      guarded: false,
      write: true,
      handler: ({ ids }) => bulkOp(TOOL_GMAIL_ARCHIVE_MESSAGE, ids, archiveDelta(), `ids=${(ids as string[]).join(',')}`),
    },
    {
      name: TOOL_GMAIL_MARK_READ,
      description: 'Mark one or more messages read/unread (toggle UNREAD). Reversible. Batch limited to 10.',
      inputSchema: { ids: z.array(z.string()), read: z.boolean() },
      guarded: false,
      write: true,
      handler: ({ ids, read }) =>
        bulkOp(TOOL_GMAIL_MARK_READ, ids, markReadDelta(read), `ids=${(ids as string[]).join(',')} read=${read}`),
    },
    {
      name: TOOL_GMAIL_STAR_MESSAGE,
      description: 'Star/unstar one or more messages (toggle STARRED). Reversible. Batch limited to 10.',
      inputSchema: { ids: z.array(z.string()), starred: z.boolean() },
      guarded: false,
      write: true,
      handler: ({ ids, starred }) =>
        bulkOp(TOOL_GMAIL_STAR_MESSAGE, ids, starDelta(starred), `ids=${(ids as string[]).join(',')} starred=${starred}`),
    },
    {
      name: TOOL_GMAIL_LABEL_MESSAGE,
      description: 'Apply or remove a user label on one or more messages. Reversible. Batch limited to 10.',
      inputSchema: { ids: z.array(z.string()), labelId: z.string(), apply: z.boolean() },
      guarded: false,
      write: true,
      handler: ({ ids, labelId, apply }) =>
        bulkOp(TOOL_GMAIL_LABEL_MESSAGE, ids, labelDelta(labelId, apply), `ids=${(ids as string[]).join(',')} label=${labelId} apply=${apply}`),
    },
    {
      name: TOOL_GMAIL_MARK_SPAM,
      description: 'Mark one or more messages as spam (add SPAM, remove INBOX). Reversible. Batch limited to 10.',
      inputSchema: { ids: z.array(z.string()) },
      guarded: false,
      write: true,
      handler: ({ ids }) => bulkOp(TOOL_GMAIL_MARK_SPAM, ids, spamDelta(), `ids=${(ids as string[]).join(',')}`),
    },
    {
      name: TOOL_GMAIL_UNMARK_SPAM,
      description: 'Remove spam marking and restore to inbox. Reversible. Batch limited to 10.',
      inputSchema: { ids: z.array(z.string()) },
      guarded: false,
      write: true,
      handler: ({ ids }) => bulkOp(TOOL_GMAIL_UNMARK_SPAM, ids, unspamDelta(), `ids=${(ids as string[]).join(',')}`),
    },
    {
      name: TOOL_GMAIL_MOVE_TO_INBOX,
      description: 'Restore a single message from Trash or Spam back to the inbox.',
      inputSchema: { id: z.string() },
      guarded: false,
      write: true,
      handler: async ({ id }) => {
        const out = await moveToInbox(await tok(), id, f)
        audit(TOOL_GMAIL_MOVE_TO_INBOX, `id=${id}`)
        return jsonResult(out)
      },
    },
    {
      name: TOOL_GMAIL_TRASH_MESSAGE,
      description: 'Move a single message to Trash (30-day recoverable). ASK-FIRST GUARDED. One message per call.',
      inputSchema: { id: z.string() },
      guarded: true,
      write: true,
      handler: async ({ id }) => {
        const out = await trashMessage(await tok(), id, f)
        audit(TOOL_GMAIL_TRASH_MESSAGE, `id=${id}`)
        return jsonResult(out)
      },
    },

    // --- Gmail labels (gmail.labels) ---
    {
      name: TOOL_GMAIL_LIST_LABELS,
      description: 'List all Gmail label definitions (system + user).',
      inputSchema: {},
      guarded: false,
      write: false,
      handler: async () => jsonResult(await listLabels(await tok(), f)),
    },
    {
      name: TOOL_GMAIL_CREATE_LABEL,
      description: 'Create a new Gmail label definition.',
      inputSchema: { name: z.string() },
      guarded: false,
      write: true,
      handler: async ({ name }) => {
        const out = await createLabel(await tok(), { name }, f)
        audit(TOOL_GMAIL_CREATE_LABEL, `name=${name} id=${out.id ?? ''}`)
        return jsonResult(out)
      },
    },
    {
      name: TOOL_GMAIL_UPDATE_LABEL,
      description: 'Rename or recolour a Gmail label definition.',
      inputSchema: { id: z.string(), name: z.string().optional() },
      guarded: false,
      write: true,
      handler: async ({ id, name }) => {
        const out = await updateLabel(await tok(), id, { name }, f)
        audit(TOOL_GMAIL_UPDATE_LABEL, `id=${id}`)
        return jsonResult(out)
      },
    },
    {
      name: TOOL_GMAIL_DELETE_LABEL,
      description: 'Delete a Gmail label definition (un-labels all messages). ASK-FIRST GUARDED. System labels are refused.',
      inputSchema: { id: z.string() },
      guarded: true,
      write: true,
      handler: async ({ id }) => {
        const out = await deleteLabel(await tok(), id, f)
        if (!('error' in out)) audit(TOOL_GMAIL_DELETE_LABEL, `id=${id}`)
        return jsonResult(out)
      },
    },

    // --- Gmail filters + settings (gmail.settings.basic) ---
    {
      name: TOOL_GMAIL_LIST_FILTERS,
      description: 'List all existing Gmail message filters.',
      inputSchema: {},
      guarded: false,
      write: false,
      handler: async () => jsonResult(await listFilters(await tok(), f)),
    },
    {
      name: TOOL_GMAIL_CREATE_FILTER,
      description: 'Create a Gmail filter (archive/label/trash/mark-read; no forwarding). ASK-FIRST GUARDED.',
      inputSchema: { criteria: z.record(z.string(), z.any()), action: z.record(z.string(), z.any()) },
      guarded: true,
      write: true,
      handler: async ({ criteria, action }) => {
        const out = await createFilter(await tok(), { criteria, action }, f)
        if (!('error' in out)) audit(TOOL_GMAIL_CREATE_FILTER, `criteria=${Object.keys(criteria).join('+')} action=${Object.keys(action).join('+')}`)
        return jsonResult(out)
      },
    },
    {
      name: TOOL_GMAIL_DELETE_FILTER,
      description: 'Delete a Gmail filter rule. ASK-FIRST GUARDED.',
      inputSchema: { id: z.string() },
      guarded: true,
      write: true,
      handler: async ({ id }) => {
        const out = await deleteFilter(await tok(), id, f)
        audit(TOOL_GMAIL_DELETE_FILTER, `id=${id}`)
        return jsonResult(out)
      },
    },
    {
      name: TOOL_GMAIL_GET_VACATION,
      description: 'Read the current Gmail vacation auto-reply settings.',
      inputSchema: {},
      guarded: false,
      write: false,
      handler: async () => jsonResult(await getVacation(await tok(), f)),
    },
    {
      name: TOOL_GMAIL_UPDATE_VACATION,
      description: 'Set or clear the Gmail vacation auto-reply. ASK-FIRST GUARDED.',
      inputSchema: {
        enableAutoReply: z.boolean(),
        responseSubject: z.string().optional(),
        responseBodyPlainText: z.string().optional(),
        restrictToContacts: z.boolean().optional(),
        startTime: z.string().optional(),
        endTime: z.string().optional(),
      },
      guarded: true,
      write: true,
      handler: async (args) => {
        const out = await updateVacation(await tok(), args, f)
        audit(TOOL_GMAIL_UPDATE_VACATION, `enabled=${args.enableAutoReply}`)
        return jsonResult(out)
      },
    },

    // --- Calendar read (calendar) ---
    {
      name: TOOL_CALENDAR_LIST_CALENDARS,
      description: 'List all calendars the user can access (primary + subscribed).',
      inputSchema: {},
      guarded: false,
      write: false,
      handler: async () => jsonResult(await listCalendars(await tok(), f)),
    },
    {
      name: TOOL_CALENDAR_LIST_EVENTS,
      description: 'List primary-calendar events in any [timeMin,timeMax] ISO8601 range (past/present/future).',
      inputSchema: { timeMin: z.string(), timeMax: z.string() },
      guarded: false,
      write: false,
      handler: async ({ timeMin, timeMax }) => {
        const out = await listEvents(await tok(), { timeMin, timeMax }, f)
        return textResult(fmtEvents(out.events))
      },
    },
    {
      name: TOOL_CALENDAR_SEARCH_EVENTS,
      description: 'Search primary-calendar events by text query (optional time range).',
      inputSchema: { q: z.string(), timeMin: z.string().optional(), timeMax: z.string().optional() },
      guarded: false,
      write: false,
      handler: async ({ q, timeMin, timeMax }) => {
        const out = await searchEvents(await tok(), { q, timeMin, timeMax }, f)
        return textResult(fmtEvents(out.events))
      },
    },

    // --- Calendar write (calendar) ---
    {
      name: TOOL_CALENDAR_CREATE_EVENT,
      description: 'Create an event in the primary calendar (summary/start/end, optional description/location).',
      inputSchema: eventInputShape,
      guarded: false,
      write: true,
      handler: async (args) => {
        const out = await createEvent(await tok(), args, f)
        audit(TOOL_CALENDAR_CREATE_EVENT, `id=${out.id ?? ''}`)
        return textResult('Created:\n' + fmtEvent(wrapEvent(out)))
      },
    },
    {
      name: TOOL_CALENDAR_UPDATE_EVENT,
      description: 'Update fields of a SINGLE event instance. Rejects scope=all (use calendar_update_event_all).',
      inputSchema: { id: z.string(), scope: z.string().optional(), ...eventInputShape },
      guarded: false,
      write: true,
      handler: async ({ id, scope, ...patch }) => {
        const out = await updateEvent(await tok(), id, patch, { scope }, f)
        if ('error' in out) return textResult(`Error: ${out.error}`)
        audit(TOOL_CALENDAR_UPDATE_EVENT, `id=${id}`)
        return textResult('Updated:\n' + fmtEvent(wrapEvent(out)))
      },
    },
    {
      name: TOOL_CALENDAR_UPDATE_EVENT_ALL,
      description: 'Update ALL instances of a recurring event (patch the master). ASK-FIRST GUARDED.',
      inputSchema: { id: z.string(), ...eventInputShape },
      guarded: true,
      write: true,
      handler: async ({ id, ...patch }) => {
        const out = await updateEventAll(await tok(), id, patch, f)
        if ('error' in out) return textResult(`Error: ${out.error}`)
        audit(TOOL_CALENDAR_UPDATE_EVENT_ALL, `id=${id}`)
        return textResult('Updated (all instances):\n' + fmtEvent(wrapEvent(out)))
      },
    },
    {
      name: TOOL_CALENDAR_DELETE_EVENT,
      description: 'Permanently delete a calendar event. ASK-FIRST GUARDED. Writes an undo-snapshot before deleting.',
      inputSchema: { id: z.string() },
      guarded: true,
      write: true,
      handler: async ({ id }) => {
        const dir = join(deps.channelDir, 'deleted-events')
        const out = await deleteEvent(await tok(), id, dir, f)
        if (!('error' in out)) audit(TOOL_CALENDAR_DELETE_EVENT, `id=${id} snapshot=${out.snapshot}`)
        return jsonResult(out)
      },
    },

    // --- ENG-048 Drive (scope drive -- full read+write, Boss TG4809) ---
    // The drive fetch shape needs arrayBuffer() (binary download); the injected
    // FetchLike (or the real global fetch) satisfies it -- cast once here.
    {
      name: TOOL_DRIVE_LIST_FILES,
      description:
        'List/search Google Drive files (optional Drive query q, e.g. "name contains \'x\'" or "\'<folderId>\' in parents"). Read-only. Names are untrusted-wrapped.',
      inputSchema: { q: z.string().optional(), pageSize: z.number().optional() },
      guarded: false,
      write: false,
      handler: async ({ q, pageSize }) => {
        const out = await driveListFiles(await tok(), { q, pageSize }, df)
        return textResult(fmtDriveList(out.files))
      },
    },
    {
      name: TOOL_DRIVE_DOWNLOAD_FILE,
      description:
        'Download a Drive file by fileId to a local path under the channel downloads/ dir (0600). Read-only. destPath is confined to downloads/ (path-traversal rejected); defaults to downloads/<name> when omitted.',
      inputSchema: { fileId: z.string(), destPath: z.string().optional() },
      guarded: false,
      write: false,
      handler: async ({ fileId, destPath }) => {
        // SEC: dest is confined to the downloads/ subdir -- a prompt-injected
        // destPath cannot escape to clobber arbitrary local files.
        const downloadsRoot = join(deps.channelDir, 'downloads')
        let dest: string
        try {
          dest = destPath
            ? confineToRoot(downloadsRoot, destPath)
            : join(downloadsRoot, await safeDownloadName(fileId))
        } catch (err) {
          return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`)
        }
        const out = await driveDownloadFile(await tok(), fileId, dest, df)
        return jsonResult(out)
      },
    },
    {
      name: TOOL_DRIVE_UPLOAD_FILE,
      description:
        'Upload a local file to Drive (scope drive). If fileId is given the target file is OVERWRITTEN (its current version is backed up locally FIRST); otherwise a NEW file is created. ASK-FIRST GUARDED: irreversible external write to the Boss Drive.',
      inputSchema: {
        srcPath: z.string().describe('local path of the file to upload'),
        name: z.string().optional().describe('Drive filename (defaults to the source basename)'),
        fileId: z.string().optional().describe('existing Drive fileId to OVERWRITE (omit to create new)'),
        parents: z.array(z.string()).optional().describe('parent folder id(s) for a NEW file'),
        mimeType: z.string().optional(),
      },
      guarded: true,
      write: true,
      handler: async ({ srcPath, name, fileId, parents, mimeType }) => {
        // SEC: srcPath is confined to the uploads/ subdir -- a prompt-injected
        // srcPath cannot exfiltrate secrets (oauth-tokens.json lives directly in
        // channelDir, NOT under uploads/) or any other local file to Drive.
        let safeSrc: string
        try {
          safeSrc = confineToRoot(join(deps.channelDir, 'uploads'), srcPath)
        } catch (err) {
          return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`)
        }
        // Read the local source bytes first -- a bad path fails loud before any
        // Drive call (and before any backup).
        let media: Uint8Array
        try {
          media = new Uint8Array(readFileSync(safeSrc))
        } catch (err) {
          return textResult(`Error: cannot read source file ${safeSrc}: ${err instanceof Error ? err.message : String(err)}`)
        }

        // PRE-WRITE BACKUP (Boss requirement): on OVERWRITE, snapshot the current
        // Drive version locally BEFORE writing. Order is load-bearing:
        // guard (already passed) -> backup -> write. If the backup throws, we do
        // NOT write (fail-safe -- never overwrite what we could not back up).
        let backupPath: string | null = null
        if (fileId) {
          try {
            backupPath = await backupDriveFileVersion(await tok(), fileId, driveBackupDir, deps.now(), df)
          } catch (err) {
            return textResult(`Error: pre-write backup failed, upload ABORTED (no Drive write performed): ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        const uploadName = name ?? basename(safeSrc)
        const out = await driveUploadFile(await tok(), media, { name: uploadName, fileId, parents, mimeType }, df)
        // NEW file (no backup) -> audit line only, per Boss decision.
        audit(TOOL_DRIVE_UPLOAD_FILE, `id=${out.id ?? ''} mode=${fileId ? 'overwrite' : 'new'} backup=${backupPath ?? 'none'}`)
        return jsonResult({ ...out, backup: backupPath })
      },
    },
  ]

  // Look up a Drive file's real name for the default download filename; fall
  // back to the id if the metadata fetch fails.
  async function safeDownloadName(fileId: string): Promise<string> {
    try {
      const meta = await driveGetMeta(await tok(), fileId, df)
      if (!('error' in meta) && meta.name) {
        return meta.name.replace(/[\r\n]+/g, ' ').replace(/[/\\\0]/g, '_').slice(0, 200)
      }
    } catch {
      /* fall through */
    }
    return fileId
  }

  // Shared executor for the bulk-capable message ops: enforces the bulk
  // threshold (handled in applyToMessages, pre-fetch) and surfaces the reject as
  // a tool result rather than a thrown error.
  async function bulkOp(tool: string, ids: string[], delta: any, summary: string) {
    try {
      const out = await applyToMessages(await tok(), ids, delta, f)
      audit(tool, summary)
      return jsonResult(out)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return textResult(msg)
    }
  }
}

export function buildServer(deps?: Partial<ToolDeps>): McpServer {
  const server = new McpServer({ name: SERVER_KEY, version: '2.0.0' })
  const resolved: ToolDeps = {
    getToken: deps?.getToken ?? defaultGetToken,
    channelDir: deps?.channelDir ?? CHANNEL_DIR,
    now: deps?.now ?? (() => Date.now()),
    fetchFn: deps?.fetchFn,
    driveBackupDir: deps?.driveBackupDir ?? DRIVE_BACKUP_DIR,
  }
  for (const def of buildToolDefs(resolved)) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema }, def.handler)
  }
  return server
}

async function main(): Promise<void> {
  // SEC-AC4 fail-loud: refuse to run a write-capable server without an audit
  // surface. The dir is the google channel dir; the audit log + undo-snapshots
  // live under it.
  assertAuditDir(CHANNEL_DIR)
  const server = buildServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Run only when executed directly (not when imported by a test).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
if (invokedDirectly) {
  main().catch((err) => {
    // stderr only -- stdout is the MCP protocol channel.
    console.error('[claudia-google-mcp] fatal:', err)
    process.exit(1)
  })
}
