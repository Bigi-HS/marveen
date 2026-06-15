import { resolve, sep } from 'node:path'

// NFD + combining-mark strip so Hungarian input like "etrendiro" decays
// to "etrendiro" instead of silently losing every accented character
// and producing "trendr".
export function sanitizeAgentName(raw: string): string {
  return raw.trim().toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
}

// Same rules as sanitizeAgentName -- used for skill names to prevent path traversal.
export function sanitizeSkillName(raw: string): string {
  return sanitizeAgentName(raw)
}

export function sanitizeScheduleName(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

// Resolve a raw URL path segment to a safe schedule name for the mutating
// routes (PUT/DELETE/toggle/run). Decodes percent-encoding, strips it through
// sanitizeScheduleName, and returns null for anything that sanitizes to empty
// (e.g. "..", "%2e%2e", "/") so a traversal payload can never resolve to the
// scheduled-tasks parent dir. A null result must map to 404. Malformed
// percent-encoding (decodeURIComponent throws) is also rejected.
export function safeScheduleName(rawSegment: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawSegment)
  } catch {
    return null
  }
  const name = sanitizeScheduleName(decoded)
  return name || null
}

// Joins segments and verifies the resolved path stays inside `base`. Throws on escape.
export function safeJoin(base: string, ...parts: string[]): string {
  const resolvedBase = resolve(base)
  const target = resolve(base, ...parts)
  if (target !== resolvedBase && !target.startsWith(resolvedBase + sep)) {
    throw new Error(`Path traversal rejected: ${parts.join('/')}`)
  }
  return target
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
