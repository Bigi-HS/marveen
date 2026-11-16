// Wiring test for card 7469c9bd (Boss TG9616): every Telegram-channel agent must
// AUTOMATICALLY handle inbound image / voice / video, as a standard fleet capability
// rather than per-agent ad-hoc. The agreed landing path is the TRACKED generator
// (src/web/agent-scaffold.ts generateClaudeMd), which bakes a mandatory section into
// every newly generated CLAUDE.md -- the per-agent agents/*/CLAUDE.md files are
// gitignored+untracked and cannot be PR-gated (see card A2-BLOCKER note).
//
// Like agent-scaffold-claude-md-prompt.test.ts, we assert on the prompt STRING
// (the mandatory-section text the LLM is told to copy exactly), not on an LLM
// invocation. The regression we lock down is "the inbound-multimodal section is
// present and references the three local-first processing paths".

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD_PATH = join(__dirname, '..', 'web', 'agent-scaffold.ts')

describe('generateClaudeMd: inbound multimodal (kép/hang/videó) mandatory section', () => {
  const src = readFileSync(SCAFFOLD_PATH, 'utf-8')

  const promptStart = src.indexOf('export async function generateClaudeMd')
  expect(promptStart, 'generateClaudeMd entry not found').toBeGreaterThan(0)
  const promptEnd = src.indexOf('export async function generateSoulMd')
  expect(promptEnd, 'generateSoulMd terminator not found').toBeGreaterThan(promptStart)
  const promptBody = src.slice(promptStart, promptEnd)

  // Isolate the inbound-multimodal section so our content assertions cannot be
  // accidentally satisfied by unrelated prose elsewhere in the prompt.
  const blockStart = promptBody.indexOf('## Bejövő multimédia')
  it('includes the "## Bejövő multimédia" mandatory section header', () => {
    expect(blockStart, 'inbound-multimodal section header not found').toBeGreaterThan(0)
  })

  const restAfterBlock = promptBody.slice(blockStart + 5)
  const nextHeader = restAfterBlock.indexOf('\n## ')
  const block = promptBody.slice(
    blockStart,
    blockStart + 5 + (nextHeader > 0 ? nextHeader : restAfterBlock.length),
  )

  it('instructs automatic processing before replying (no manual skill call needed)', () => {
    expect(block).toMatch(/AUTOMATIKUSAN/)
    expect(block).toMatch(/válaszol/i)
  })

  it('covers the image path (Read vision + download_attachment)', () => {
    expect(block).toMatch(/[Kk]ép/)
    expect(block).toContain('Read')
    expect(block).toContain('download_attachment')
  })

  it('covers the voice path (voice-transcribe / whisper, [Hang átirat] prefix)', () => {
    expect(block).toContain('voice-transcribe')
    expect(block).toMatch(/[Hh]ang átirat/)
  })

  it('covers the video path via the tracked inbound-video-handle.sh script', () => {
    expect(block).toContain('inbound-video-handle.sh')
    expect(block).toMatch(/ffmpeg/)
    expect(block).toMatch(/keyframe/i)
  })

  it('is token-aware: local tools, only final text/description goes to the model', () => {
    expect(block).toMatch(/[Ll]okális/)
    // keyframe count must be bounded to avoid burning vision tokens
    expect(block).toMatch(/korlátozd|korlátoz/i)
  })
})
