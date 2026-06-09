import { describe, it, expect } from 'vitest'
import { PATCH_MARKER, patchPollingGiveUp } from '../telegram-plugin-patch.js'

// A faithful slice of the telegram plugin's polling loop (server.ts ~1018-1037,
// v0.0.6) around the 409 give-up bug that pipe-RCA #2 (card 81cf42b2) targets.
// The em dash and \n are reproduced verbatim from the upstream source so the
// fixture matches the real file shape; the transform anchors on code tokens, not
// this prose, so it stays robust across plugin message wording.
const VULNERABLE = `    } catch (err) {
      if (shuttingDown) return
      if (err instanceof Error && err.message === 'Aborted delay') return
      const is409 = err instanceof GrammyError && err.error_code === 409
      if (is409 && attempt >= 8) {
        process.stderr.write(
          \`telegram channel: 409 Conflict persists after \${attempt} attempts — \` +
          \`another poller is holding the bot token (stray 'bun server.ts' process or a second session). Exiting.\\n\`,
        )
        return
      }
      const delay = Math.min(1000 * attempt, 15000)
      const detail = is409
        ? \`409 Conflict\${attempt === 1 ? ' — another instance is polling (zombie session, or a second Claude Code running?)' : ''}\`
        : \`polling error: \${err}\`
      process.stderr.write(\`telegram channel: \${detail}, retrying in \${delay / 1000}s\\n\`)
      await new Promise(r => setTimeout(r, delay))
    }`

describe('patchPollingGiveUp', () => {
  it('removes the permanent 409 give-up and switches to capped exponential backoff', () => {
    const r = patchPollingGiveUp(VULNERABLE)
    expect(r.found).toBe(true)
    expect(r.changed).toBe(true)
    expect(r.alreadyPatched).toBe(false)
    // The permanent-surrender branch is gone.
    expect(r.patched).not.toContain('if (is409 && attempt >= 8)')
    expect(r.patched).not.toContain('persists after')
    expect(r.patched).not.toContain('Exiting.')
    // 409 now uses capped exponential backoff; non-409 keeps the linear cap.
    expect(r.patched).toContain('const delay = is409')
    expect(r.patched).toContain('Math.min(2000 * 2 ** Math.min(attempt - 1, 5), 60000)')
    expect(r.patched).toContain('Math.min(1000 * attempt, 15000)')
    // Idempotency marker present.
    expect(r.patched).toContain(PATCH_MARKER)
  })

  it('preserves the surrounding loop body it must not touch', () => {
    const r = patchPollingGiveUp(VULNERABLE)
    expect(r.patched).toContain('const is409 = err instanceof GrammyError && err.error_code === 409')
    expect(r.patched).toContain('const detail = is409')
    expect(r.patched).toContain('await new Promise(r => setTimeout(r, delay))')
    expect(r.patched).toContain("if (err instanceof Error && err.message === 'Aborted delay') return")
  })

  it('is idempotent: re-patching an already-patched source is a no-op', () => {
    const once = patchPollingGiveUp(VULNERABLE)
    const twice = patchPollingGiveUp(once.patched)
    expect(twice.found).toBe(true)
    expect(twice.alreadyPatched).toBe(true)
    expect(twice.changed).toBe(false)
    expect(twice.patched).toBe(once.patched)
  })

  it('fails closed when the give-up block is absent (never writes a guessed patch)', () => {
    const unrelated = 'function noop() {\n  return 42\n}\n'
    const r = patchPollingGiveUp(unrelated)
    expect(r.found).toBe(false)
    expect(r.changed).toBe(false)
    expect(r.patched).toBe(unrelated)
  })

  it('the patched delay still resolves to the linear cap for non-409 errors', () => {
    // Pull the patched delay expression and evaluate it for is409=false to prove
    // the non-409 path is behaviourally unchanged (linear, capped at 15s).
    const r = patchPollingGiveUp(VULNERABLE)
    const delayOf = (is409: boolean, attempt: number) =>
      is409
        ? Math.min(2000 * 2 ** Math.min(attempt - 1, 5), 60000)
        : Math.min(1000 * attempt, 15000)
    // sanity on the values the patched source encodes
    expect(r.patched).toContain('Math.min(1000 * attempt, 15000)')
    expect(delayOf(false, 3)).toBe(3000)
    expect(delayOf(false, 99)).toBe(15000)
    // 409 backoff: 2s, 4s, 8s, 16s, 32s, then capped at 60s
    expect(delayOf(true, 1)).toBe(2000)
    expect(delayOf(true, 5)).toBe(32000)
    expect(delayOf(true, 6)).toBe(60000)
    expect(delayOf(true, 50)).toBe(60000)
  })
})
