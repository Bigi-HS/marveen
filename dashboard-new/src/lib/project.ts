/**
 * Canonical card-code taxonomy prefixes (card cf0d1bfe, enum-widen Boss TG4599).
 * Mirrors the server-side `CARD_PROJECTS` in src/noa-kanban.ts -- the two lists
 * must stay in lock-step; the server is the source of truth and rejects any value
 * outside this set on the write path (#439). 27 prefixes: PA retired (folded to
 * ASST on the server), 14 new granular codes added. Order matches the server
 * declaration; this is the validity set, NOT the display-lane order.
 */
export const CARD_PROJECTS = [
  'DASH', 'CORE', 'MEM', 'OPS', 'ENG', 'AGENT', 'KANB', 'FIX', 'WEB', 'OAUTH', 'SEC',
  'CONT', 'DUB', 'DL', 'DISC', 'BIGI', 'FABLE', 'KHOOT', 'VOICE', 'CV',
  'ASST', 'EDU', 'WELL', 'DEC', 'RES', 'DND', 'BUCC',
] as const

/**
 * CONT-family: content sub-topics that are first-class project VALUES on the
 * server, but on the board they render under the single CONT lane (Boss TG4599:
 * "5 kód, 1 vizuális lane"). groupCardsByProject folds these into CONT.
 */
export const CONT_FAMILY = ['DUB', 'DL', 'DISC', 'BIGI'] as const

/**
 * DISPLAY-lane order for the project-grouped board view: CARD_PROJECTS minus the
 * CONT-family members (they collapse into the CONT lane, so they are not their
 * own lanes). CONT itself stays and represents the whole family.
 */
export const PROJECT_LANES = CARD_PROJECTS.filter(
  (p) => !(CONT_FAMILY as readonly string[]).includes(p),
)

/** Header label for the uncategorized (null / non-canonical) project lane. */
export const PROJECT_GROUP_OTHER_LABEL = 'Egyéb'
