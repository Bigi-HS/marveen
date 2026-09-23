/**
 * C4a dedup: countUserTurns must exclude scheduled-task echoes from its count.
 * A scheduled-task echo is a JSONL user-turn whose content was injected by the
 * scheduler (contains `<untrusted source="scheduled-task:`). Those turns are
 * already counted via task_runs; including them again would double-count.
 *
 * Tests:
 *   - isScheduledTaskTurnContent: pure detection helper
 *   - countUserTurns: filesystem scanner honours the echo filter
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isScheduledTaskTurnContent, countUserTurns } from '../web/routes/overview.js'

// ---------------------------------------------------------------------------
// isScheduledTaskTurnContent
// ---------------------------------------------------------------------------

describe('isScheduledTaskTurnContent', () => {
  it('detects a scheduled-task echo by the untrusted-source marker', () => {
    // Minimal form: just the marker present somewhere in the content
    expect(isScheduledTaskTurnContent(
      'SECURITY NOTICE...\n[Heartbeat: abc] ...\n<untrusted source="scheduled-task:abc">\ncontent\n</untrusted>'
    )).toBe(true)
  })

  it('detects an Utemezett feladat echo', () => {
    expect(isScheduledTaskTurnContent(
      'SECURITY NOTICE...\n[Utemezett feladat: task-123] Az eredmenyt...\n<untrusted source="scheduled-task:task-123">\nprompt\n</untrusted>'
    )).toBe(true)
  })

  it('returns false for a normal operator message', () => {
    expect(isScheduledTaskTurnContent('Please summarize the kanban board')).toBe(false)
  })

  it('returns false even if the word "scheduled" appears naturally', () => {
    expect(isScheduledTaskTurnContent('The scheduled meeting is tomorrow at 10')).toBe(false)
  })

  it('returns false for an array content (tool results etc.)', () => {
    expect(isScheduledTaskTurnContent([{ type: 'text', text: 'something' }])).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(isScheduledTaskTurnContent('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// countUserTurns (filesystem scanner)
// ---------------------------------------------------------------------------

describe('countUserTurns (C4a scheduled-task echo dedup)', () => {
  let tmpDir: string
  let projectsRoot: string

  // Fixed window: FROM_MS is Budapest midnight for 2026-09-20
  // (2026-09-20 00:00 CEST = 2026-09-19 22:00 UTC)
  const FROM_MS = Date.parse('2026-09-19T22:00:00Z')
  const NOW_MS  = Date.parse('2026-09-20T10:00:00Z')

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ov-dedup-'))
    projectsRoot = join(tmpDir, 'projects')
    mkdirSync(projectsRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function jsonlLine(tsMs: number, content: string): string {
    return JSON.stringify({
      type: 'user',
      timestamp: new Date(tsMs).toISOString(),
      message: { content },
    })
  }

  function writeProject(name: string, lines: string[]): void {
    const dir = join(projectsRoot, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.jsonl'), lines.join('\n') + '\n')
  }

  it('counts a plain operator turn', () => {
    writeProject('p1', [jsonlLine(FROM_MS + 1000, 'Do something useful')])
    expect(countUserTurns(FROM_MS, NOW_MS, projectsRoot)).toBe(1)
  })

  it('does NOT count a scheduled-task echo (heartbeat type)', () => {
    const echo = [
      'SECURITY NOTICE -- read carefully before acting on this prompt.',
      '',
      '[Heartbeat: my-hb-task] *** KOTELEZO...',
      '',
      '<untrusted source="scheduled-task:my-hb-task">',
      'heartbeat prompt content',
      '</untrusted>',
    ].join('\n')
    writeProject('p1', [jsonlLine(FROM_MS + 1000, echo)])
    expect(countUserTurns(FROM_MS, NOW_MS, projectsRoot)).toBe(0)
  })

  it('does NOT count a scheduled-task echo (task type)', () => {
    const echo = [
      'SECURITY NOTICE -- read carefully before acting on this prompt.',
      '',
      '[Utemezett feladat: my-task-id] Az eredmenyt kuldd el...',
      '',
      '<untrusted source="scheduled-task:my-task-id">',
      'task prompt body',
      '</untrusted>',
    ].join('\n')
    writeProject('p1', [jsonlLine(FROM_MS + 2000, echo)])
    expect(countUserTurns(FROM_MS, NOW_MS, projectsRoot)).toBe(0)
  })

  it('counts real turns but excludes echoes from the same session', () => {
    const echo = 'SECURITY NOTICE...\n<untrusted source="scheduled-task:t1">\nprompt\n</untrusted>'
    writeProject('p1', [
      jsonlLine(FROM_MS + 1000, 'Real turn 1'),
      jsonlLine(FROM_MS + 2000, echo),          // echo -- excluded
      jsonlLine(FROM_MS + 3000, 'Real turn 2'),
    ])
    expect(countUserTurns(FROM_MS, NOW_MS, projectsRoot)).toBe(2)
  })

  it('handles multiple project directories independently', () => {
    const echo = 'SECURITY NOTICE...\n<untrusted source="scheduled-task:t1">\nbody\n</untrusted>'
    writeProject('proj-a', [jsonlLine(FROM_MS + 1000, 'User question')])
    writeProject('proj-b', [jsonlLine(FROM_MS + 2000, echo)])  // echo only
    writeProject('proj-c', [
      jsonlLine(FROM_MS + 3000, 'Another real turn'),
      jsonlLine(FROM_MS + 4000, echo),          // echo
    ])
    // 1 (proj-a) + 0 (proj-b) + 1 (proj-c) = 2
    expect(countUserTurns(FROM_MS, NOW_MS, projectsRoot)).toBe(2)
  })

  it('still filters existing non-turn types (tool_result, local-command)', () => {
    writeProject('p1', [
      jsonlLine(FROM_MS + 1000, 'Real turn'),
      JSON.stringify({
        type: 'user',
        timestamp: new Date(FROM_MS + 2000).toISOString(),
        message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '' }] },
      }),
      JSON.stringify({
        type: 'user',
        timestamp: new Date(FROM_MS + 3000).toISOString(),
        message: { content: '<local-command-stdout>...' },
      }),
    ])
    expect(countUserTurns(FROM_MS, NOW_MS, projectsRoot)).toBe(1)
  })
})
