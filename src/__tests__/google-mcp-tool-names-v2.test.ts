import { describe, it, expect } from 'vitest'
import {
  SERVER_KEY,
  namespacedToolName,
  // v2 tool-name constants (sample of unguarded reads/writes)
  TOOL_GMAIL_LIST_MESSAGES,
  TOOL_GMAIL_GET_MESSAGE,
  TOOL_CALENDAR_LIST_EVENTS,
  TOOL_CALENDAR_UPDATE_EVENT,
  // the 7 v2 GUARDED tool-name constants (ask-first=YES)
  TOOL_GMAIL_TRASH_MESSAGE,
  TOOL_GMAIL_DELETE_LABEL,
  TOOL_GMAIL_CREATE_FILTER,
  TOOL_GMAIL_DELETE_FILTER,
  TOOL_GMAIL_UPDATE_VACATION,
  TOOL_CALENDAR_DELETE_EVENT,
  TOOL_CALENDAR_UPDATE_EVENT_ALL,
  // ENG-048 Drive tool-name constants
  TOOL_DRIVE_LIST_FILES,
  TOOL_DRIVE_DOWNLOAD_FILE,
  TOOL_DRIVE_UPLOAD_FILE,
  // the 7 v2 GUARDED namespaced strings (must equal GUARDED_TOOLS in the hook)
  GUARDED_GMAIL_TRASH,
  GUARDED_GMAIL_DELETE_LABEL,
  GUARDED_GMAIL_CREATE_FILTER,
  GUARDED_GMAIL_DELETE_FILTER,
  GUARDED_GMAIL_UPDATE_VACATION,
  GUARDED_CALENDAR_DELETE_EVENT,
  GUARDED_CALENDAR_UPDATE_EVENT_ALL,
  // ENG-048: the one guarded Drive write (overwrite is irreversible)
  GUARDED_DRIVE_UPLOAD,
} from '../mcp/tool-names.js'

// SEC-AC5: every ask-first=YES tool MUST be cross-pinned. The guarded string the
// python guardrail registers is reconstructed here from SERVER_KEY + the tool
// constant, so a rename on either side breaks this test and forces the
// guardrail (and the python cross-pin) to be updated in lockstep. v1 tests stay
// untouched (F-AC10); these are the v2 additions only.
describe('Claudia Google MCP v2 tool names', () => {
  it('namespaces v2 unguarded tools transform-free as mcp__claudia_google__<tool>', () => {
    expect(SERVER_KEY).toBe('claudia_google')
    expect(namespacedToolName(TOOL_GMAIL_LIST_MESSAGES)).toBe('mcp__claudia_google__gmail_list_messages')
    expect(namespacedToolName(TOOL_GMAIL_GET_MESSAGE)).toBe('mcp__claudia_google__gmail_get_message')
    expect(namespacedToolName(TOOL_CALENDAR_LIST_EVENTS)).toBe('mcp__claudia_google__calendar_list_events')
    expect(namespacedToolName(TOOL_CALENDAR_UPDATE_EVENT)).toBe('mcp__claudia_google__calendar_update_event')
  })

  it('pins the 7 v2 guarded names to their exact namespaced strings', () => {
    expect(GUARDED_GMAIL_TRASH).toBe('mcp__claudia_google__gmail_trash_message')
    expect(GUARDED_GMAIL_DELETE_LABEL).toBe('mcp__claudia_google__gmail_delete_label')
    expect(GUARDED_GMAIL_CREATE_FILTER).toBe('mcp__claudia_google__gmail_create_filter')
    expect(GUARDED_GMAIL_DELETE_FILTER).toBe('mcp__claudia_google__gmail_delete_filter')
    expect(GUARDED_GMAIL_UPDATE_VACATION).toBe('mcp__claudia_google__gmail_update_vacation')
    expect(GUARDED_CALENDAR_DELETE_EVENT).toBe('mcp__claudia_google__calendar_delete_event')
    expect(GUARDED_CALENDAR_UPDATE_EVENT_ALL).toBe('mcp__claudia_google__calendar_update_event_all')
  })

  it('derives each guarded string from namespacedToolName(tool constant) (no drift)', () => {
    expect(GUARDED_GMAIL_TRASH).toBe(namespacedToolName(TOOL_GMAIL_TRASH_MESSAGE))
    expect(GUARDED_GMAIL_DELETE_LABEL).toBe(namespacedToolName(TOOL_GMAIL_DELETE_LABEL))
    expect(GUARDED_GMAIL_CREATE_FILTER).toBe(namespacedToolName(TOOL_GMAIL_CREATE_FILTER))
    expect(GUARDED_GMAIL_DELETE_FILTER).toBe(namespacedToolName(TOOL_GMAIL_DELETE_FILTER))
    expect(GUARDED_GMAIL_UPDATE_VACATION).toBe(namespacedToolName(TOOL_GMAIL_UPDATE_VACATION))
    expect(GUARDED_CALENDAR_DELETE_EVENT).toBe(namespacedToolName(TOOL_CALENDAR_DELETE_EVENT))
    expect(GUARDED_CALENDAR_UPDATE_EVENT_ALL).toBe(namespacedToolName(TOOL_CALENDAR_UPDATE_EVENT_ALL))
  })
})

// ENG-048: the 3 Drive tools -- transform-free namespacing + the single guarded
// upload cross-pin (overwrite = irreversible external write). list/download are
// read-only and NOT guarded.
describe('Claudia Google MCP Drive tool names (ENG-048)', () => {
  it('namespaces the 3 Drive tools transform-free', () => {
    expect(namespacedToolName(TOOL_DRIVE_LIST_FILES)).toBe('mcp__claudia_google__drive_list_files')
    expect(namespacedToolName(TOOL_DRIVE_DOWNLOAD_FILE)).toBe('mcp__claudia_google__drive_download_file')
    expect(namespacedToolName(TOOL_DRIVE_UPLOAD_FILE)).toBe('mcp__claudia_google__drive_upload_file')
  })

  it('pins the guarded drive_upload_file string and derives it without drift', () => {
    expect(GUARDED_DRIVE_UPLOAD).toBe('mcp__claudia_google__drive_upload_file')
    expect(GUARDED_DRIVE_UPLOAD).toBe(namespacedToolName(TOOL_DRIVE_UPLOAD_FILE))
  })
})
