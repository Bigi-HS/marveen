/**
 * Canonical card-code taxonomy prefixes (card cf0d1bfe). Mirrors the server-side
 * `CARD_PROJECTS` in src/noa-kanban.ts -- the two lists must stay in lock-step;
 * the server is the source of truth and rejects any value outside this set on the
 * write path (#439). Order here is the DISPLAY order for the project-grouped board
 * view (S3): the same fixed order in which the server declares them.
 */
export const CARD_PROJECTS = [
  'DASH', 'CORE', 'MEM', 'OPS', 'ENG', 'CONT', 'SEC',
  'PA', 'EDU', 'WELL', 'DEC', 'RES', 'DND', 'BUCC',
] as const

/** Header label for the uncategorized (null / non-canonical) project lane. */
export const PROJECT_GROUP_OTHER_LABEL = 'Egyéb'
