import { resolve, sep } from 'node:path'

// Resolution + traversal guard for the NOA_DB_PATH cutover switch (card 88849f24;
// Chad #287 security finding). The noa.db cutover is flipped by pointing
// NOA_DB_PATH at the migrated database. Because that value selects which file the
// live DB handle opens, it MUST be constrained: a non-.db or out-of-root value
// is a path-traversal / wrong-target surface. This is the pure, lexical half of
// the guard (unit-tested); initDatabase adds a realpath re-check for an existing
// target to also defeat symlink escape.

/**
 * Resolve the configured NOA_DB_PATH against the project root, or fall back to
 * the default DB path when it is unset/blank. Throws if the value does not end
 * in `.db` or if it resolves outside the project root (rejecting `../` escapes
 * and absolute out-of-root paths).
 *
 * @param envValue     raw NOA_DB_PATH (may be undefined/blank).
 * @param projectRoot  absolute project root the DB must live under.
 * @param defaultPath  path returned when envValue is unset/blank.
 */
export function resolveNoaDbPath(
  envValue: string | undefined,
  projectRoot: string,
  defaultPath: string,
): string {
  const raw = envValue?.trim()
  if (!raw) return defaultPath

  // resolve() normalizes `..` segments and makes a relative value absolute
  // against the project root; an already-absolute value is normalized in place.
  const resolved = resolve(projectRoot, raw)

  if (!resolved.toLowerCase().endsWith('.db')) {
    throw new Error(`NOA_DB_PATH must point to a .db file: ${raw}`)
  }

  // Containment: the resolved path must sit strictly UNDER the project root.
  // The trailing separator stops a sibling like "/home/proj-evil/x.db" from
  // passing a bare prefix check against "/home/proj".
  const rootWithSep = projectRoot.endsWith(sep) ? projectRoot : projectRoot + sep
  if (!resolved.startsWith(rootWithSep)) {
    throw new Error(`NOA_DB_PATH escapes the project root: ${raw}`)
  }

  return resolved
}
