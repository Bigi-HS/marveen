// Card 930bba69 AC-P2a: reply-hook observe phase.
//
// Dry-run observer: computes what sanitizeCardIds WOULD substitute on a
// Boss-facing reply payload, logs the candidates, but does NOT modify output.
// Output is always bit-identical to input (pure passthrough).
//
// Controlled by OPS151_REPLY_HOOK env flag (default OFF):
//   OFF: zero logging, bit-identical passthrough
//   ON:  1 JSONL WARN per call to logs/server.log (ops151.reply-hook prefix)

import { logger } from '../../logger.js'
import { type CardCodeResolver } from './notify-sanitize.js'

// Same pattern as notify-sanitize.ts: standalone 8-char lowercase-hex token.
// Case-insensitive so an uppercase card-id (930BBA69) is also caught.
const CARD_ID_RE = /\b[0-9a-f]{8}\b/gi

/** Observe what sanitizeCardIds WOULD substitute on `text`, then return the
 *  original text unchanged. When OPS151_REPLY_HOOK=1, emits one JSONL WARN
 *  per call with the list of substitution candidates. */
export function observeReplyPayload(
  text: string,
  resolve: CardCodeResolver,
  _parseMode?: string,
): string {
  if (process.env.OPS151_REPLY_HOOK !== '1') return text

  const candidates: Array<{ token: string; would_become: string }> = []
  const re = new RegExp(CARD_ID_RE.source, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const token = match[0]
    const card = resolve(token.toLowerCase())
    if (card) {
      candidates.push({
        token,
        would_become: card.code ?? '[card]',
      })
    }
  }

  logger.warn(
    {
      type: 'ops151.reply-hook',
      candidate_count: candidates.length,
      candidates,
    },
    'ops151.reply-hook: dry-run observe',
  )

  return text
}
