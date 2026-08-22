// Pure transform for pipe-RCA #2 (card 81cf42b2).
//
// The Telegram channel plugin's polling loop (claude-plugins-official telegram
// server.ts) permanently surrenders after 8 consecutive 409 Conflicts:
//
//     const is409 = err instanceof GrammyError && err.error_code === 409
//     if (is409 && attempt >= 8) { ...; return }      // <-- the bug
//     const delay = Math.min(1000 * attempt, 15000)
//
// `return` exits the retry IIFE, so the worker process stays alive (MCP stdin
// keeps it up) but never polls again -- Telegram reports the slot free (200),
// so nothing respawns it: the agent is alive-but-deaf until a manual /mcp. This
// is the dominant Telegram-pipe-death mode (see store/telegram-pipe-rca.md).
//
// The fix removes the permanent give-up and keeps retrying 409s with capped
// exponential backoff (2s,4s,8s,16s,32s,then 60s), so polling resumes on its
// own the moment the conflicting poller releases the slot. Non-409 errors keep
// their existing linear backoff. The transform anchors on stable code tokens
// (not the log prose) and is idempotent via PATCH_MARKER, so it is safe to run
// repeatedly and across plugin message-wording changes.

export const PATCH_MARKER = '[pipe-rca2-patch]'

export interface PatchResult {
  patched: string
  // true if the give-up block (or the marker) was located -- caller MUST NOT
  // write the file when this is false (fail-closed: never write a guessed patch).
  found: boolean
  // true if this call modified the source.
  changed: boolean
  // true if the source already carried the patch.
  alreadyPatched: boolean
}

// Matches the permanent-surrender block, anchored on the `if (is409 && attempt
// >= 8) {` guard through its `return` and closing brace. Non-greedy body span so
// it captures the process.stderr.write(...) call regardless of message text.
const GIVE_UP_RE =
  /\n[ \t]*if \(is409 && attempt >= 8\) \{[\s\S]*?\n[ \t]*return\n[ \t]*\}/

// The original linear-backoff delay line (the only occurrence; the non-409 path).
const DELAY_LINE = 'const delay = Math.min(1000 * attempt, 15000)'

const NEW_DELAY = `// ${PATCH_MARKER} 409 conflicts are transient (a stray 'bun server.ts', a
      // second session, or the dashboard coordinator briefly holding the slot).
      // Do NOT permanently surrender: the old 8-conflict give-up left the worker
      // alive-but-deaf forever (Telegram then reports the slot free, so nothing
      // respawns it). Keep retrying with capped exponential backoff so polling
      // resumes the moment the slot frees. See pipe-RCA #2 (card 81cf42b2).
      const delay = is409
        ? Math.min(2000 * 2 ** Math.min(attempt - 1, 5), 60000)
        : Math.min(1000 * attempt, 15000)`

export function patchPollingGiveUp(src: string): PatchResult {
  if (src.includes(PATCH_MARKER)) {
    return { patched: src, found: true, changed: false, alreadyPatched: true }
  }
  const hasGiveUp = GIVE_UP_RE.test(src)
  const hasDelay = src.includes(DELAY_LINE)
  if (!hasGiveUp || !hasDelay) {
    return { patched: src, found: false, changed: false, alreadyPatched: false }
  }
  const patched = src
    .replace(GIVE_UP_RE, '')
    .replace(DELAY_LINE, NEW_DELAY)
  return { patched, found: true, changed: patched !== src, alreadyPatched: false }
}
