// Boss display-name rule (TG3771, fleet-wide hard rule): user-facing output must
// show the Boss-given display name, never the internal agent id. Only the five
// non-trivial remaps are pinned here; every other id is its own capitalized name
// (hyphens read as word breaks). Source of truth: agent-config team + fleet-org.
const REMAP: Record<string, string> = {
  marveen: 'NoA',
  scout: 'Dr. Stone',
  forge: 'Armorer',
  quill: 'Kalapács',
  'devil-advocate': 'Ördög Ügyvédje',
}

/** Map an agent id to its display name. Null/empty stays null so the caller
 *  chooses the placeholder ("kiosztatlan", "—", ...). */
export function agentDisplayName(id: string | null | undefined): string | null {
  if (!id) return null
  const remap = REMAP[id]
  if (remap) return remap
  return id
    .split('-')
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ')
}
