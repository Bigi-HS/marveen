// Single source of truth for the Claudia Google MCP server identity and its tool
// names. The ask-first guardrail (scripts/hooks/guardrail-ask-first.py) must
// register the EXACT namespaced name of the send tool; this module is the
// canonical definition that both the server and the cross-pin test read, so the
// guarded name and the served name cannot silently drift apart.

// The mcpServers key under which this server is wired into Claudia's .mcp.json.
// Deliberately spelled with only [a-z_] so Claude Code's tool namespacing applies
// NO character transform: the live tool name is exactly `mcp__<SERVER_KEY>__<tool>`.
// (A hyphenated key would be sanitized and the guarded string could drift.)
export const SERVER_KEY = 'claudia_google'

// --- v1 (live, unchanged) ---
export const TOOL_CALENDAR_TODAY = 'calendar_today'
export const TOOL_GMAIL_SEND = 'gmail_send'

// --- v2 Gmail message ops (scope gmail.modify) ---
export const TOOL_GMAIL_LIST_MESSAGES = 'gmail_list_messages'
export const TOOL_GMAIL_GET_MESSAGE = 'gmail_get_message'
export const TOOL_GMAIL_GET_THREAD = 'gmail_get_thread'
export const TOOL_GMAIL_LIST_THREADS = 'gmail_list_threads'
export const TOOL_GMAIL_ARCHIVE_MESSAGE = 'gmail_archive_message'
export const TOOL_GMAIL_MARK_READ = 'gmail_mark_read'
export const TOOL_GMAIL_STAR_MESSAGE = 'gmail_star_message'
export const TOOL_GMAIL_LABEL_MESSAGE = 'gmail_label_message'
export const TOOL_GMAIL_MOVE_TO_INBOX = 'gmail_move_to_inbox'
export const TOOL_GMAIL_MARK_SPAM = 'gmail_mark_spam'
export const TOOL_GMAIL_UNMARK_SPAM = 'gmail_unmark_spam'
export const TOOL_GMAIL_TRASH_MESSAGE = 'gmail_trash_message'

// --- v2 Gmail label management (scope gmail.labels) ---
export const TOOL_GMAIL_LIST_LABELS = 'gmail_list_labels'
export const TOOL_GMAIL_CREATE_LABEL = 'gmail_create_label'
export const TOOL_GMAIL_UPDATE_LABEL = 'gmail_update_label'
export const TOOL_GMAIL_DELETE_LABEL = 'gmail_delete_label'

// --- v2 Gmail filters + settings (scope gmail.settings.basic) ---
export const TOOL_GMAIL_LIST_FILTERS = 'gmail_list_filters'
export const TOOL_GMAIL_CREATE_FILTER = 'gmail_create_filter'
export const TOOL_GMAIL_DELETE_FILTER = 'gmail_delete_filter'
export const TOOL_GMAIL_GET_VACATION = 'gmail_get_vacation'
export const TOOL_GMAIL_UPDATE_VACATION = 'gmail_update_vacation'

// --- v2 Calendar read (scope calendar) ---
export const TOOL_CALENDAR_LIST_CALENDARS = 'calendar_list_calendars'
export const TOOL_CALENDAR_LIST_EVENTS = 'calendar_list_events'
export const TOOL_CALENDAR_SEARCH_EVENTS = 'calendar_search_events'

// --- v2 Calendar write (scope calendar) ---
export const TOOL_CALENDAR_CREATE_EVENT = 'calendar_create_event'
export const TOOL_CALENDAR_UPDATE_EVENT = 'calendar_update_event'
export const TOOL_CALENDAR_UPDATE_EVENT_ALL = 'calendar_update_event_all'
export const TOOL_CALENDAR_DELETE_EVENT = 'calendar_delete_event'

// How Claude Code namespaces an MCP tool: mcp__<server>__<tool>.
export function namespacedToolName(tool: string): string {
  return `mcp__${SERVER_KEY}__${tool}`
}

// The exact names the ask-first guardrail must guard. Kept in lockstep with
// GUARDED_TOOLS in scripts/hooks/guardrail-ask-first.py; the python tests pin
// them and the deploy doc has a live `claude mcp`-roster verification step.
// v1:
export const GUARDED_GMAIL_SEND = namespacedToolName(TOOL_GMAIL_SEND)
// v2 (SEC-AC5) -- the 7 catastrophic / irreversible ops (GP-AC2, non-weakeneable):
export const GUARDED_GMAIL_TRASH = namespacedToolName(TOOL_GMAIL_TRASH_MESSAGE)
export const GUARDED_GMAIL_DELETE_LABEL = namespacedToolName(TOOL_GMAIL_DELETE_LABEL)
export const GUARDED_GMAIL_CREATE_FILTER = namespacedToolName(TOOL_GMAIL_CREATE_FILTER)
export const GUARDED_GMAIL_DELETE_FILTER = namespacedToolName(TOOL_GMAIL_DELETE_FILTER)
export const GUARDED_GMAIL_UPDATE_VACATION = namespacedToolName(TOOL_GMAIL_UPDATE_VACATION)
export const GUARDED_CALENDAR_DELETE_EVENT = namespacedToolName(TOOL_CALENDAR_DELETE_EVENT)
export const GUARDED_CALENDAR_UPDATE_EVENT_ALL = namespacedToolName(TOOL_CALENDAR_UPDATE_EVENT_ALL)
