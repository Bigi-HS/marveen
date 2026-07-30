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

export type CardProject = (typeof CARD_PROJECTS)[number]

/** Rank of a project in canonical order; unknown/non-canonical sorts last. */
export function projectOrder(project: string | null | undefined): number {
  const i = (CARD_PROJECTS as readonly string[]).indexOf(project ?? '')
  return i === -1 ? CARD_PROJECTS.length : i
}

/** Header label for a project group. The uncategorized bucket (null) reads as a
 *  short Hungarian dash-label; a canonical prefix is shown verbatim. */
export const PROJECT_GROUP_OTHER_LABEL = 'Egyéb'
