// Card 930bba69 AC-P1-1 -- Boss-facing notify payload card-id rewrite.
//
// A raw 8-char hex card-id (e.g. `930bba69`) must not appear in the Boss-facing
// Telegram payload. The rewrite is MEMBERSHIP-RESOLVE, not a blind pattern-strip:
// only a token that resolves to a KNOWN card is rewritten -- to the card's
// canonical `PREFIX-NNN` code, or a placeholder when the card carries no code.
// Any other 8-hex-shaped token (a git short SHA, a hex colour fragment, a random
// hex) is NOT a card id and is left untouched -- blind-stripping it would mangle
// legitimate same-shaped data (git SHA vs card-id). See the fleet lesson
// `shared-identifier-rewrite-resolve-membership-not-blind-pattern`.

/** Resolves a candidate id to its card record (code may be null), or null when the
 *  id is not a known card. Injected so the route layer can bind the kanban lookup
 *  while tests stay hermetic. */
export type CardCodeResolver = (id: string) => { code: string | null } | null

// Word-boundary 8-hex: matches a standalone `[0-9a-f]{8}` token. A 40-char SHA has
// no internal word boundary, so this never matches inside it; a 7-char short SHA is
// too short to match. Card-ids in this system are exactly 8 lowercase-hex chars.
const CARD_ID_RE = /\b[0-9a-f]{8}\b/g

const PLACEHOLDER = '[card]'

// MarkdownV2 reserved chars (Telegram Bot API). Escaped with a leading backslash.
const MDV2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!]/g

/** Escape an INJECTED replacement for the message's parse_mode. The caller already
 *  escaped its own text; we only escape the token we add (code / placeholder), whose
 *  `-` / `[` / `]` would otherwise break MarkdownV2 rendering. HTML and plain text
 *  need no escaping here (the replacements contain no `<`/`>`/`&`). */
function escapeForParseMode(token: string, parseMode?: string): string {
  if (parseMode === 'MarkdownV2') return token.replace(MDV2_SPECIAL, '\\$&')
  return token
}

/** Rewrite every known card-id in `text` to its code (or a placeholder), leaving
 *  non-card hex tokens untouched. Never emits a raw card-id. */
export function sanitizeCardIds(
  text: string,
  resolve: CardCodeResolver,
  parseMode?: string,
): string {
  return text.replace(CARD_ID_RE, (token) => {
    const card = resolve(token)
    if (!card) return token // not a known card -> legitimate same-shaped data, untouched
    return escapeForParseMode(card.code ?? PLACEHOLDER, parseMode)
  })
}
