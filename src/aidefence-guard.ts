// AIDefence guard: deterministic PII + prompt-injection filter for
// POST /api/messages. Runs BEFORE createAgentMessage so a blocked
// message never reaches the DB or any downstream agent.
//
// Verdict semantics:
//   PASS  -- nothing found; allow through
//   FLAG  -- suspicious content; allow through, log at warn level
//   BLOCK -- clear injection or critical-severity PII; reject with 400
//
// Severity → verdict mapping:
//   PII critical (e.g. PEM private key)              → BLOCK
//   PROMPT_INJECTION critical / high                 → BLOCK
//   PII high / medium (email, token-bearing line, …) → FLAG
//   PROMPT_INJECTION medium                          → FLAG

export type Severity = 'low' | 'medium' | 'high' | 'critical'
export type Verdict = 'PASS' | 'FLAG' | 'BLOCK'

export interface Finding {
  type: 'PII' | 'PROMPT_INJECTION'
  /** short name of the matched pattern rule */
  pattern: string
  /** context window; actual PII value REDACTED, injection text preserved */
  excerpt: string
  severity: Severity
}

export interface GuardResult {
  verdict: Verdict
  findings: Finding[]
}

// ── internals ────────────────────────────────────────────────────────────────

interface PatternDef {
  type: 'PII' | 'PROMPT_INJECTION'
  name: string
  rx: RegExp
  severity: Severity
}

// Build a fresh RegExp from a template so exec() state never bleeds between
// calls (global flag stateful lastIndex).
function freshRx(def: PatternDef): RegExp {
  return new RegExp(def.rx.source, def.rx.flags)
}

// For PII: show surrounding context but REDACT the matched value so the
// finding can be logged without re-leaking the secret.
function piiExcerpt(text: string, match: RegExpExecArray, ctx = 20): string {
  const before = text.slice(Math.max(0, match.index - ctx), match.index).replace(/\n/g, ' ')
  const after  = text.slice(match.index + match[0].length, match.index + match[0].length + ctx).replace(/\n/g, ' ')
  return `${before}[REDACTED]${after}`
}

// For injection: show matched text + context so reviewers see the exact phrase.
function injectionExcerpt(text: string, match: RegExpExecArray, ctx = 30): string {
  const start = Math.max(0, match.index - ctx)
  const end   = Math.min(text.length, match.index + match[0].length + ctx)
  return text.slice(start, end).replace(/\n/g, ' ')
}

// ── pattern tables ────────────────────────────────────────────────────────────

const PII_PATTERNS: PatternDef[] = [
  {
    type: 'PII',
    name: 'email',
    rx: /\b[a-zA-Z0-9._%+-]{3,}@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/gi,
    severity: 'medium',
  },
  {
    type: 'PII',
    name: 'phone',
    // Matches common international/US formats: +1 (555) 123-4567, 555-123-4567
    rx: /\b(?:\+?\d{1,3}[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}\b/g,
    severity: 'medium',
  },
  {
    type: 'PII',
    name: 'pem-header',
    // A PEM private key block is a critical secret; never allow in transit.
    rx: /-----BEGIN [A-Z ]+-----/g,
    severity: 'critical',
  },
  {
    type: 'PII',
    name: 'aws-key',
    rx: /\bAKIA[0-9A-Z]{16}\b/g,
    severity: 'high',
  },
  {
    type: 'PII',
    name: 'github-token',
    rx: /\b(?:ghp|ghs|gho|ghr)_[a-zA-Z0-9]{36,}\b|\bgithub_pat_[a-zA-Z0-9_]{22,}\b/g,
    severity: 'high',
  },
  {
    type: 'PII',
    name: 'openai-key',
    rx: /\bsk-[a-zA-Z0-9]{32,}\b/g,
    severity: 'high',
  },
  {
    type: 'PII',
    name: 'anthropic-key',
    // Anthropic API keys start with sk-ant-
    rx: /\bsk-ant-[a-zA-Z0-9_\-]{32,}\b/g,
    severity: 'high',
  },
  {
    type: 'PII',
    name: 'token-assignment',
    // Key=value or key: value patterns where the value is 16+ non-space chars.
    // Catches hardcoded tokens, passwords, secrets in plain text.
    rx: /(?:api[_-]?key|secret|token|password|passwd|pwd|bearer)\s*[=:]\s*['"]?[a-zA-Z0-9+/=_\-]{16,}/gi,
    severity: 'high',
  },
  {
    type: 'PII',
    name: 'credit-card',
    // 16-digit groups separated by spaces or hyphens (Luhn not checked).
    rx: /\b\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{4}\b/g,
    severity: 'medium',
  },
]

const INJECTION_PATTERNS: PatternDef[] = [
  {
    type: 'PROMPT_INJECTION',
    name: 'ignore-instructions',
    rx: /ignore\s+(?:all\s+)?previous\s+instructions?/gi,
    severity: 'critical',
  },
  {
    type: 'PROMPT_INJECTION',
    name: 'forget-instructions',
    rx: /forget\s+(?:all\s+)?(?:previous\s+)?instructions?/gi,
    severity: 'critical',
  },
  {
    type: 'PROMPT_INJECTION',
    name: 'disregard-instructions',
    rx: /disregard\s+(?:all\s+)?(?:previous\s+)?instructions?/gi,
    severity: 'critical',
  },
  {
    type: 'PROMPT_INJECTION',
    name: 'new-system-prompt',
    rx: /new\s+system\s+(?:prompt|message|instructions?)/gi,
    severity: 'critical',
  },
  {
    type: 'PROMPT_INJECTION',
    name: 'override-instructions',
    rx: /override\s+(?:your\s+)?(?:previous\s+)?instructions?/gi,
    severity: 'high',
  },
  {
    type: 'PROMPT_INJECTION',
    name: 'role-override',
    // "you are now DAN", "you are now jailbroken", "you are now an unrestricted AI"
    rx: /you\s+are\s+now\s+(?:DAN\b|jailbroken|an?\s+unrestricted)/gi,
    severity: 'high',
  },
  {
    type: 'PROMPT_INJECTION',
    name: 'exfiltrate-prompt',
    // "print/reveal/send/repeat [me] your system prompt / instructions / CLAUDE.md"
    rx: /(?:print|reveal|output|show|repeat|send|exfiltrate)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?|CLAUDE\.md)/gi,
    severity: 'high',
  },
  {
    type: 'PROMPT_INJECTION',
    name: 'jailbreak-token',
    // Classic jailbreak names and enablement phrases
    rx: /\bDAN\s*\d+\b|Do\s+Anything\s+Now|developer\s+mode\s+enabled|jailbreak\s+mode/gi,
    severity: 'medium',
  },
]

// ── public API ────────────────────────────────────────────────────────────────

export function aiDefenceGuard(_from: string, content: string): GuardResult {
  const findings: Finding[] = []

  for (const def of PII_PATTERNS) {
    const m = freshRx(def).exec(content)
    if (m) {
      findings.push({
        type: def.type,
        pattern: def.name,
        excerpt: piiExcerpt(content, m),
        severity: def.severity,
      })
    }
  }

  for (const def of INJECTION_PATTERNS) {
    const m = freshRx(def).exec(content)
    if (m) {
      findings.push({
        type: def.type,
        pattern: def.name,
        excerpt: injectionExcerpt(content, m),
        severity: def.severity,
      })
    }
  }

  return { verdict: calcVerdict(findings), findings }
}

function calcVerdict(findings: Finding[]): Verdict {
  if (findings.length === 0) return 'PASS'
  const shouldBlock = findings.some(f =>
    f.severity === 'critical' ||
    (f.type === 'PROMPT_INJECTION' && f.severity === 'high'),
  )
  return shouldBlock ? 'BLOCK' : 'FLAG'
}
