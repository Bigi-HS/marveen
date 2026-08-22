import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PROJECT_ROOT, OWNER_NAME, MAIN_AGENT_ID, BOT_NAME, CHANNEL_PROVIDER } from '../config.js'
import { channelStateDir } from '../channel-provider.js'
import { runAgent } from '../agent.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { agentDir } from './agent-config.js'
import { resolveProfilePlaceholders, type ProfileTemplate } from './profiles.js'

function resolveTemplatePlaceholders(content: string): string {
  return content.replaceAll('{{PROJECT_ROOT}}', PROJECT_ROOT)
}

// Substring that uniquely identifies the SessionStart memory auto-inject hook
// inside a hooks-block command, so the targeted merge below can find it in the
// template and detect whether an agent already carries it.
const MEMORY_HOOK_MARKER = 'memory-replay.py'

// Same idea for the PreToolUse Telegram broadcast/injection guardrail (item 2b):
// uniquely identifies its hook command so the targeted merge can backfill it
// into agents that already have a hooks block (and would otherwise be skipped
// by the all-or-nothing seed forever).
const GUARDRAIL_HOOK_MARKER = 'guardrail-telegram-chat.py'

// And the PreToolUse ask-first approval gate (item 2b, "ask first" bucket):
// gates irreversible/external-effect MCP tools behind the confirm-channel.
const ASK_FIRST_HOOK_MARKER = 'guardrail-ask-first.py'

// And the PreToolUse destructive-Bash hard-block (card dd48afb6): a narrow
// deny-list that flat-blocks catastrophic Bash commands (rm -rf root, force-push
// to a protected branch, SQL DROP via a client, PAT cred-file print).
const DESTRUCTIVE_BASH_HOOK_MARKER = 'guardrail-destructive-bash.py'

// And the PreToolUse last-match-wins permission ruleset (card 13974213): external-
// directory deny, .env file read deny, external curl mutating-method deny.
const PERMISSION_RULES_HOOK_MARKER = 'guardrail-permission-rules.py'

// And the SessionStart per-agent enforcement reminder (card 03a4f57d): the hook is
// agent-generic (it no-ops for agents without a configured check) so it is safe to
// backfill fleet-wide -- hibiki gets the inbox-check, claudia the email ask-first.
const SESSION_ENFORCE_HOOK_MARKER = 'session-start-enforce.py'

// And the UserPromptSubmit long-session anti-bloat freshness nudge (card 705381e3):
// threshold-gated + rate-limited, fleet-wide, no-ops on normal turns.
const FRESHNESS_NUDGE_HOOK_MARKER = 'prompt-freshness-nudge.py'

type HookCommand = { type?: string; command?: string; prompt?: string }
type HookEntry = { matcher?: string; hooks?: HookCommand[] }
type HooksBlock = Record<string, HookEntry[]>

function entryReferences(entry: HookEntry, marker: string): boolean {
  return (entry.hooks ?? []).some(h => typeof h.command === 'string' && h.command.includes(marker))
}

// Targeted idempotent merge: ensure the template's memory SessionStart
// auto-inject hook(s) are present in `target`. Returns true iff it mutated
// `target`. It only ever ADDS the memory entry (appended to SessionStart);
// it never removes or rewrites the agent's own hooks. This is what lets an
// agent that already has a hooks block -- and is therefore skipped by the
// all-or-nothing seed in ensureAgentHooks -- still pick up a hook that was
// added to the template after the agent was first scaffolded.
export function ensureMemoryHook(target: HooksBlock, template: HooksBlock): boolean {
  const memoryEntries = (template.SessionStart ?? []).filter(e => entryReferences(e, MEMORY_HOOK_MARKER))
  if (memoryEntries.length === 0) return false  // template has no memory hook -> nothing to merge
  const existingStart = target.SessionStart ?? []
  if (existingStart.some(e => entryReferences(e, MEMORY_HOOK_MARKER))) return false  // already present
  target.SessionStart = [...existingStart, ...memoryEntries]
  return true
}

// Targeted idempotent merge of the PreToolUse Telegram guardrail, mirroring
// ensureMemoryHook. ADD-only: appends the template's guardrail entry to the
// agent's PreToolUse list iff absent; never removes or rewrites an agent's own
// PreToolUse hooks. This is what makes the guard drift-proof -- every existing
// agent picks it up at the next boot backfill without a profile rewrite.
export function ensureGuardrailHook(target: HooksBlock, template: HooksBlock): boolean {
  const entries = (template.PreToolUse ?? []).filter(e => entryReferences(e, GUARDRAIL_HOOK_MARKER))
  if (entries.length === 0) return false  // template has no guardrail hook -> nothing to merge
  const existing = target.PreToolUse ?? []
  if (existing.some(e => entryReferences(e, GUARDRAIL_HOOK_MARKER))) return false  // already present
  target.PreToolUse = [...existing, ...entries]
  return true
}

// Targeted idempotent merge of the PreToolUse ask-first approval gate, mirroring
// ensureGuardrailHook. ADD-only, drift-proof: backfilled into every existing
// agent at the next boot, never removing or rewriting an agent's own hooks.
export function ensureAskFirstHook(target: HooksBlock, template: HooksBlock): boolean {
  const entries = (template.PreToolUse ?? []).filter(e => entryReferences(e, ASK_FIRST_HOOK_MARKER))
  if (entries.length === 0) return false  // template has no ask-first hook -> nothing to merge
  const existing = target.PreToolUse ?? []
  if (existing.some(e => entryReferences(e, ASK_FIRST_HOOK_MARKER))) return false  // already present
  target.PreToolUse = [...existing, ...entries]
  return true
}

// Targeted idempotent merge of the PreToolUse destructive-Bash hard-block,
// mirroring ensureAskFirstHook. ADD-only, drift-proof: backfilled into every
// existing agent at the next boot so the deny-list reaches the whole fleet
// without a profile rewrite, never removing or rewriting an agent's own hooks.
export function ensureDestructiveBashHook(target: HooksBlock, template: HooksBlock): boolean {
  const entries = (template.PreToolUse ?? []).filter(e => entryReferences(e, DESTRUCTIVE_BASH_HOOK_MARKER))
  if (entries.length === 0) return false  // template has no destructive-bash hook -> nothing to merge
  const existing = target.PreToolUse ?? []
  if (existing.some(e => entryReferences(e, DESTRUCTIVE_BASH_HOOK_MARKER))) return false  // already present
  target.PreToolUse = [...existing, ...entries]
  return true
}

// Targeted idempotent merge of the PreToolUse permission-rules gate (card 13974213):
// external-directory deny, .env file read deny, external-curl mutating deny.
// ADD-only; never removes or rewrites existing PreToolUse entries.
export function ensurePermissionRulesHook(target: HooksBlock, template: HooksBlock): boolean {
  const entries = (template.PreToolUse ?? []).filter(e => entryReferences(e, PERMISSION_RULES_HOOK_MARKER))
  if (entries.length === 0) return false
  const existing = target.PreToolUse ?? []
  if (existing.some(e => entryReferences(e, PERMISSION_RULES_HOOK_MARKER))) return false
  target.PreToolUse = [...existing, ...entries]
  return true
}

// Targeted idempotent merge of the SessionStart per-agent enforcement reminder
// (card 03a4f57d), mirroring ensureMemoryHook. ADD-only, drift-proof: backfilled
// into every existing agent's SessionStart at the next boot; the hook itself
// no-ops for agents without a configured reminder.
export function ensureSessionEnforceHook(target: HooksBlock, template: HooksBlock): boolean {
  const entries = (template.SessionStart ?? []).filter(e => entryReferences(e, SESSION_ENFORCE_HOOK_MARKER))
  if (entries.length === 0) return false
  const existing = target.SessionStart ?? []
  if (existing.some(e => entryReferences(e, SESSION_ENFORCE_HOOK_MARKER))) return false
  target.SessionStart = [...existing, ...entries]
  return true
}

// Targeted idempotent merge of the UserPromptSubmit long-session freshness nudge
// (card 705381e3). ADD-only; creates the UserPromptSubmit block if the agent has
// none (older agents were scaffolded without one), never rewrites existing entries.
export function ensureFreshnessNudgeHook(target: HooksBlock, template: HooksBlock): boolean {
  const entries = (template.UserPromptSubmit ?? []).filter(e => entryReferences(e, FRESHNESS_NUDGE_HOOK_MARKER))
  if (entries.length === 0) return false
  const existing = target.UserPromptSubmit ?? []
  if (existing.some(e => entryReferences(e, FRESHNESS_NUDGE_HOOK_MARKER))) return false
  target.UserPromptSubmit = [...existing, ...entries]
  return true
}

// Idempotent migration: every agent's settings.json should carry the shared
// hooks (PreCompact memory-save/skill-reflection + the SessionStart taskstate
// and memory auto-inject replays). Two cases:
//   - Pre-refactor agents have a permissions-only file (no hooks block): seed
//     the whole template hooks block.
//   - Agents that already have a hooks block were scaffolded before a given
//     hook existed in the template, so the all-or-nothing seed would skip them
//     forever. For those we run a targeted merge of just the memory hook.
export function ensureAgentHooks(name: string): boolean {
  const settingsPath = join(agentDir(name), '.claude', 'settings.json')
  const tplPath = join(PROJECT_ROOT, 'templates', 'settings.json.template')
  if (!existsSync(tplPath)) return false
  let tpl: Record<string, unknown>
  try {
    const raw = resolveTemplatePlaceholders(readFileSync(tplPath, 'utf-8'))
    tpl = JSON.parse(raw)
  } catch {
    return false
  }
  if (!tpl.hooks) return false
  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* overwrite */ }
  }
  let changed = false
  if (!existing.hooks) {
    existing.hooks = tpl.hooks  // permissions-only agent -> seed full template hooks
    changed = true
  } else {
    // Agent already has hooks: leave them alone, but additively backfill the
    // hooks added to the template after the agent was scaffolded -- the memory
    // auto-inject (SessionStart) and the Telegram guardrail (PreToolUse).
    const memChanged = ensureMemoryHook(existing.hooks as HooksBlock, tpl.hooks as HooksBlock)
    const guardChanged = ensureGuardrailHook(existing.hooks as HooksBlock, tpl.hooks as HooksBlock)
    const askFirstChanged = ensureAskFirstHook(existing.hooks as HooksBlock, tpl.hooks as HooksBlock)
    const destructiveBashChanged = ensureDestructiveBashHook(existing.hooks as HooksBlock, tpl.hooks as HooksBlock)
    const permRulesChanged = ensurePermissionRulesHook(existing.hooks as HooksBlock, tpl.hooks as HooksBlock)
    const sessionEnforceChanged = ensureSessionEnforceHook(existing.hooks as HooksBlock, tpl.hooks as HooksBlock)
    const freshnessNudgeChanged = ensureFreshnessNudgeHook(existing.hooks as HooksBlock, tpl.hooks as HooksBlock)
    changed = memChanged || guardChanged || askFirstChanged || destructiveBashChanged || permRulesChanged
      || sessionEnforceChanged || freshnessNudgeChanged
  }
  if (!changed) return false
  mkdirSync(join(agentDir(name), '.claude'), { recursive: true })
  atomicWriteFileSync(settingsPath, JSON.stringify(existing, null, 2))
  return true
}

export function writeAgentSettingsFromProfile(name: string, profile: ProfileTemplate): void {
  const agentRoot = agentDir(name)
  const settingsDir = join(agentRoot, '.claude')
  const settingsPath = join(settingsDir, 'settings.json')
  mkdirSync(settingsDir, { recursive: true })
  let existing: Record<string, unknown> = {}
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, 'utf-8')) } catch { /* overwrite */ }
  }
  const ctx = { HOME: homedir(), AGENT_DIR: agentRoot }
  existing.permissions = {
    allow: profile.filesystem.allow.map(p => resolveProfilePlaceholders(p, ctx)),
    deny: profile.filesystem.deny.map(p => resolveProfilePlaceholders(p, ctx)),
  }
  atomicWriteFileSync(settingsPath, JSON.stringify(existing, null, 2))
}

// Copy the repo's `scheduled-tasks/<task>/task-config.json` to the
// destination with the `agent` field rewritten to the host's
// MAIN_AGENT_ID. The repo-side configs ship with `"agent": "marveen"`
// hardcoded (canonical default in src/config.ts) so a non-marveen
// install would otherwise scaffold tasks bound to an agent that does
// not exist and the scheduler would fire silently into the void on
// every tick. All other files in the task directory (SKILL.md, etc.)
// are byte-identical copies as before.
//
// The rewrite is conservative: it only touches the `agent` field, and
// only when the parsed JSON has one. A malformed task-config.json
// falls back to copyFileSync so the seed does not lose its file --
// the operator can then inspect and fix the JSON, rather than the
// scaffold silently dropping the task.
function copyTaskConfigWithAgentRewrite(srcPath: string, destPath: string): void {
  try {
    const raw = readFileSync(srcPath, 'utf-8')
    const cfg = JSON.parse(raw) as Record<string, unknown>
    if (typeof cfg.agent === 'string') {
      cfg.agent = MAIN_AGENT_ID
    }
    atomicWriteFileSync(destPath, JSON.stringify(cfg, null, 2) + '\n')
  } catch {
    // Malformed or unreadable: fall back to a byte copy so the file is
    // still seeded and the operator gets a chance to fix it.
    copyFileSync(srcPath, destPath)
  }
}

export function ensureDefaultScheduledTasks(): void {
  const repoTasks = join(PROJECT_ROOT, 'scheduled-tasks')
  if (!existsSync(repoTasks)) return
  const destRoot = join(homedir(), '.claude', 'scheduled-tasks')
  mkdirSync(destRoot, { recursive: true })

  for (const taskName of readdirSync(repoTasks)) {
    const src = join(repoTasks, taskName)
    const dest = join(destRoot, taskName)
    if (!statSync(src).isDirectory()) continue
    if (existsSync(dest)) continue
    mkdirSync(dest, { recursive: true })
    for (const file of readdirSync(src)) {
      const srcFile = join(src, file)
      const destFile = join(dest, file)
      if (file === 'task-config.json') {
        copyTaskConfigWithAgentRewrite(srcFile, destFile)
      } else {
        copyFileSync(srcFile, destFile)
      }
    }
  }
}

export function scaffoldAgentDir(name: string) {
  const dir = agentDir(name)
  mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
  mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true })
  mkdirSync(channelStateDir(CHANNEL_PROVIDER, dir), { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })

  // Initialize empty files if they don't exist
  const memoryMd = join(dir, 'memory', 'MEMORY.md')
  if (!existsSync(memoryMd)) writeFileSync(memoryMd, '')
  const mcpJson = join(dir, '.mcp.json')
  if (!existsSync(mcpJson)) {
    // Copy shared MCP config so agents get access to common tools (e.g. aiam-blog)
    const sharedMcp = join(PROJECT_ROOT, '.mcp.json')
    if (existsSync(sharedMcp)) {
      copyFileSync(sharedMcp, mcpJson)
    } else {
      // Valid empty shape -- `claude /doctor` rejects plain "{}"
      atomicWriteFileSync(mcpJson, JSON.stringify({ mcpServers: {} }, null, 2))
    }
  }
  // Seed settings.json from template so the agent gets the PreCompact
  // hook (memory save + skill reflection) out of the box. Only if the
  // file doesn't exist yet -- user edits and later profile writes stay.
  const settingsJson = join(dir, '.claude', 'settings.json')
  if (!existsSync(settingsJson)) {
    const tplPath = join(PROJECT_ROOT, 'templates', 'settings.json.template')
    if (existsSync(tplPath)) {
      const resolved = resolveTemplatePlaceholders(readFileSync(tplPath, 'utf-8'))
      atomicWriteFileSync(settingsJson, resolved)
    }
  }
}

export async function generateClaudeMd(name: string, description: string, model: string): Promise<string> {
  const prompt = `You are creating the CLAUDE.md (project instructions) file for an AI agent.
Agent name: ${name}
Description of what the agent should do: ${description}
Model: ${model}

Generate a comprehensive CLAUDE.md that includes:
- Clear role and responsibilities based on the description above
- Behavioral guidelines
- Communication style
- Language rules (Hungarian with ${OWNER_NAME}, English for code/technical)
- Tool usage guidelines relevant to the agent's role
- Any domain-specific instructions

The owner's name is ${OWNER_NAME}. Use this exact name everywhere the CLAUDE.md
refers to the owner/user. Do not substitute or invent any other name.

IMPORTANT FORMATTING RULES:
- Write ALL Hungarian text with proper accents (á, é, í, ó, ö, ő, ú, ü, ű). NEVER write Hungarian without accents.
- The agent's first line description should reflect what the user typed as description, in Hungarian with accents.
- Never use em dash (—), only simple hyphen (-).

IMPORTANT: The CLAUDE.md MUST include the following sections at the end (copy them exactly, replacing AGENT_NAME with ${name}):

## Memoria rendszer

A memoria 3 retegbol all (hot/warm/cold) + napi naplo.

### Tier-ek:
- **hot**: Aktiv feladatok, pending dontesek, ami MOST tortenik
- **warm**: Stabil konfig, preferenciák, projekt kontextus (ritkán változik)
- **cold**: Hosszútávú tanulságok, történeti döntések, archívum
- **shared**: Más ágenseknek is releváns információk

### NINCS MENTAL NOTE! Ha meg kell jegyezni -> AZONNAL mentsd:

Minden /api/* végpont Bearer tokenes: a token a store/.dashboard-token fájlban.

Memória mentés:
curl -s -X POST http://localhost:3420/api/memories -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)" -d '{"agent_id":"AGENT_NAME","content":"MIT","category":"CATEGORY","keywords":"kulcsszo1, kulcsszo2"}'

Napi napló (append-only):
curl -s -X POST http://localhost:3420/api/daily-log -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)" -d '{"agent_id":"AGENT_NAME","content":"## HH:MM -- Tema\nMi tortent, mi lett az eredmeny"}'

Keresés (mielőtt válaszolsz, nézd meg van-e releváns emlék):
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" "http://localhost:3420/api/memories?agent=AGENT_NAME&q=KULCSSZO&category=warm"

## Ütemezett feladatok

Az ütemezett feladatok a ~/.claude/scheduled-tasks/ mappában élnek, fájl-alapúak (SKILL.md + task-config.json). A schedule runner 60 másodpercenként ellenőrzi és a te tmux session-ödbe küldi a promptot.

Feladat létrehozása API-n keresztül:
curl -s -X POST http://localhost:3420/api/schedules -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)" -d '{"name": "feladat-nev", "description": "Rövid leírás", "prompt": "A részletes prompt", "schedule": "0 8 * * *", "agent": "AGENT_NAME", "type": "heartbeat"}'

Típusok: task (mindig szól az eredménnyel) vagy heartbeat (csak fontosnál szól).
Cron formátum: perc óra nap hónap hétnapja (pl. 0 8 * * * = minden nap 8:00).
NE írd közvetlenül az SQLite scheduled_tasks táblát - az egy régi API.

## Öntanulás és Skill rendszer

Te egy önfejlesztő ágens vagy. A munkád során tanulsz, és újrafelhasználható skill-eket hozol létre.

### Skill-ek helye
- Globális: ~/.claude/skills/ (minden ágens számára elérhető)
- Egyéni: a te munkakönyvtárad .claude/skills/ mappája

### Automatikus skill generálás
Komplex feladatok után (5+ tool hívás, hiba utáni recovery, user korrekció, többlépéses workflow) automatikusan hozz létre SKILL.md fájlt:

mkdir -p ~/.claude/skills/SKILL-NEV
A SKILL.md tartalmazzon YAML frontmatter-t (name, description), majd szekciókat: Mikor használd, Eljárás, Buktatók, Ellenőrzés.

### Skill patch (runtime javítás)
Ha egy meglévő skill használata közben jobb megoldást találsz:
1. Ne írd újra az egész skill-t, csak a megváltozott részt javítsd
2. Használj célzott cserét (régi szöveg -> új szöveg)
3. Jegyezd fel a változtatás okát a skill Buktatók szekciójába

### Mikor generálj skill-t?
- 5+ tool hívás, sikeres befejezés: Generálj skill-t
- Hiba -> recovery -> siker: Generálj skill-t (buktató szekcióval)
- User korrekció: Patch-eld a meglévő skill-t
- Nem triviális workflow: Generálj skill-t
- Egyszerű, egylépéses feladat: Ne generálj semmit

### Skill reflexió
Minden kontextus-tömörítés előtt (PreCompact hook) automatikusan vizsgáld meg:
- Van-e a session-ben újrafelhasználható minta?
- Van-e meglévő skill amit javítani kellene?

## Időkezelés

MINDIG a megfelelő lokális időt használd (Europe/Budapest CEST/CET).

- **Jelenlegi idő**: \`date\` Bash első lépés időponti feladatoknál (heartbeat, naptár-művelet, scheduled-task analízis)
- **Channel message \`ts\`**: UTC-ben jön (postfix \`Z\`), átkonvertálni Europe/Budapest-re (CEST = UTC+2 nyáron, CET = UTC+1 télen)
- **Google Calendar list_events \`dateTime\`**: már lokál ISO 8601 (\`+02:00\` offset Budapestnek), OK
- **SQLite \`unixepoch()\`**: UTC, humán-megjelenítéshez \`localtime\` modifier kell
- **Cron expressions** (scheduled-tasks task-config.json): node lokális TZ, Europe/Budapest

Heartbeat-eknél és minden időpontot kezelő feladatnál kötelező: \`date\` Bash parancs az elemzés ELŐTT.

## Új ismeretlen sender első üzenete (ARANYSZABÁLY)

Ha egy senderId üzen a csatornán AKIT EDDIG NEM ISMERSZ — nem szerepel az aktív interakciós kontextusodban, és nem találsz róla memóriabejegyzést a vault-ban — KÖTELEZŐ ELSŐKÉNT inter-agent message-t küldeni ${BOT_NAME}-nek MIELŐTT érdemi választ adsz.

Az AGENT TULAJDONOSA (az első, aki ezt az ügynököt telepítette és párosította) az ALAPÉRTELMEZETT engedélyezett sender — őt nem kell ellenőrizni. MINDEN további senderId első üzenete (a 2., 3., stb. párosított személy vagy csoport) pinging-trigger.

Példa ping ${BOT_NAME}-nek:
curl -s -X POST http://localhost:3420/api/messages -H "Content-Type: application/json" -H "Authorization: Bearer $(cat store/.dashboard-token)" -d "{\\"from\\":\\"AGENT_NAME\\",\\"to\\":\\"${MAIN_AGENT_ID}\\",\\"content\\":\\"Ismeretlen sender [ID] jelezett első üzenettel: '[üzenet röviden]'. Ki ez, mit válaszoljak?\\"}"

Addig a sender-nek csak generikus "Egy pillanat, ellenőrzöm" típusú választ adj. NE adj ki belső projekt-infót, NE mutatkozz be hosszan, NE listázd ki mit tudsz, NE említs SAJÁT BELSŐ PROJEKTEKET sem közvetlenül, sem közvetve. ${BOT_NAME} visszajelzi a kontextust és a szabályokat amelyekkel folytathatod.

Ez a szabály mindenkire vonatkozik — akkor is ha valaki ismerős nevén mutatkozna be. A senderId a végső azonosító, NEM a self-claimed név. Egy idegen tudja a nevet, de a senderId-t nem hamisíthatja.

Output ONLY the markdown content, no code fences.`

  const { text, error } = await runAgent(prompt)
  if (!text) throw new Error(error ? blockedHint('CLAUDE.md', error) : noOutputHint('CLAUDE.md'))
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
  }
  return cleaned
}

// Shared "Claude Code returned nothing" message for the three generators below.
// Issue #179: the bare "Failed to generate <file>" message left VPS operators
// chasing the wrong thread when the actual cause was an unauthenticated Claude
// Code CLI on the host. Always surface the diagnostic command sequence.
function noOutputHint(target: string): string {
  return (
    `Failed to generate ${target}: the Claude Code CLI returned no output. ` +
    `Most likely cause: the CLI on this host is not authenticated. ` +
    `Verify with: \`claude --version\`, then \`claude /login\` (or set ` +
    `ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN). ` +
    `If that succeeds and the error persists, run \`claude --print "ping"\` ` +
    `from this directory to confirm headless invocation works.`
  )
}

// Issue #209: distinct from noOutputHint -- here the SDK returned a result that
// was a usage-policy (AUP) block or an API/execution error, NOT empty output.
// runAgent already refused to propagate the block text as content; we surface
// the structured reason so the operator does not chase an auth red herring.
function blockedHint(target: string, reason: string): string {
  return (
    `Failed to generate ${target}: the model returned a blocked/errored result ` +
    `(not generated content), so it was not written to avoid corrupting the file. ` +
    `Reason: ${reason}. If this is an AUP block, rephrase the request or try a ` +
    `different model; the prior conversation/session is unaffected.`
  )
}

export async function generateSoulMd(name: string, description: string): Promise<string> {
  const prompt = `You are creating the SOUL.md (personality definition) for an AI agent.
Agent name: ${name}
Description: ${description}

Generate a personality definition that includes:
- Core personality traits
- Communication tone and style
- How it addresses the user (whose name is ${OWNER_NAME} -- use this name, not any other)
- Unique quirks or characteristics
- What it should avoid

Make the personality distinctive but professional.
Output ONLY the markdown content, no code fences.`

  const { text, error } = await runAgent(prompt)
  if (!text) throw new Error(error ? blockedHint('SOUL.md', error) : noOutputHint('SOUL.md'))
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
  }
  return cleaned
}

export async function generateSkillMd(skillName: string, description: string): Promise<string> {
  const prompt = `You are creating a SKILL.md file for a Claude Code skill. Follow this exact format:

Skill name: ${skillName}
What the user described: ${description}

Generate a SKILL.md with this structure:

1. YAML frontmatter (between --- delimiters):
   - name: ${skillName}
   - description: A comprehensive description that includes what the skill does AND specific contexts for when to use it. Be "pushy" - include multiple trigger phrases. Example: instead of "Creates reports" write "Creates detailed reports. Use this skill whenever the user mentions reports, summaries, data analysis, dashboards, metrics overview, or wants to compile information into a structured document."

2. Body with these sections:
   - # [Skill Name] - main heading
   - ## Purpose - what this skill does and why
   - ## When to use - specific triggers and contexts
   - ## Instructions - step-by-step guide for Claude
   - ## Output format - what the output should look like
   - ## Examples - 1-2 concrete examples with Input/Output
   - ## Language rules - Hungarian with ${OWNER_NAME} (the user), English for code/technical
   - ## What to avoid - common pitfalls

Keep the body under 200 lines. Be specific and actionable. The owner's name is ${OWNER_NAME}; use only this name when referring to the user.
Output ONLY the markdown content, no code fences.`

  const { text, error } = await runAgent(prompt)
  if (!text) throw new Error(error ? blockedHint('SKILL.md', error) : noOutputHint('SKILL.md'))
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
  }
  return cleaned
}
