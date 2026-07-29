// Boss display-name rule (TG3771 + TG4422/4426, fleet-wide hard rule): user-facing
// output must show the Boss-given display name, never the internal agent id. The
// non-trivial remaps are pinned here (a name that title-casing the id cannot
// produce -- a real rename, a missing accent, or a run-together id like "bigben");
// every other id falls back to its own capitalized name (hyphens read as word
// breaks). This is the CLIENT fallback; the server is config-driven via
// readAgentDisplayName (agent-config displayName). Source of truth: agent-config
// team + fleet-org.
const REMAP: Record<string, string> = {
  marveen: 'NoA',
  scout: 'Dr. Stone',
  forge: 'Armorer',
  quill: 'Kalapács',
  'devil-advocate': 'Ördög Ügyvédje',
  radar: 'Grace',
  gauge: 'Dampier',
  bigben: 'Big Ben',
  gyore: 'Györe',
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
