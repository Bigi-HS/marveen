import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { getAgentMemories, appendDailyLog } from './noa-memory.js'
import { MAIN_AGENT_ID } from './config.js'
import { runAgent } from './agent.js'
import { logger } from './logger.js'
import { wrapUntrusted, UNTRUSTED_PREAMBLE } from './prompt-safety.js'

// Dedicated cwd for the daily-digest sub-agent. We can't reuse PROJECT_ROOT
// here -- the Marveen Telegram channels session runs claude --continue in
// PROJECT_ROOT, and the SDK's per-cwd session/lock state collides with it
// when two Claude Code processes share the same project dir, dropping the
// channels plugin every night at 23:00. A throwaway dir under the user's
// `~/.claude/projects/` tree avoids the collision while keeping the SDK
// happy (it expects a writable cwd to place its session jsonl into).
//
// We honor TMPDIR via os.tmpdir() as a last-resort fallback so a hardened
// host with a read-only home still has somewhere to land.
function ensureDigestCwd(): string {
  const candidates = [join(homedir(), '.claude', 'tmp', 'marveen-digest'), join(tmpdir(), 'marveen-digest')]
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      return dir
    } catch { /* try next */ }
  }
  // Last resort: tmpdir itself. Worst case we share with whatever else is
  // in /tmp, but that still doesn't collide with the Marveen project dir.
  return tmpdir()
}

// The daily digest sub-agent inherits the host's CLAUDE_CONFIG_DIR
// (~/.claude/) by default, which means it loads the user's globally
// enabled plugins -- including telegram@claude-plugins-official. The
// Telegram Bot API only allows ONE active getUpdates connection per
// token, so the sub-agent's plugin steals the connection from the
// long-running marveen-channels session, which then logs as
// "plugin lecsatlakozott" at 23:00 every night when runDailyDigest
// fires. Workaround: hand the sub-agent a private CLAUDE_CONFIG_DIR
// with `enabledPlugins: {}` so it never spawns the Telegram MCP. The
// dir is created idempotently on first use; the settings.json is
// written only if missing so the user can edit it later if needed.
function ensureDigestConfigDir(): string {
  const candidates = [
    join(homedir(), '.claude', 'tmp', 'marveen-digest-config'),
    join(tmpdir(), 'marveen-digest-config'),
  ]
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      const settingsPath = join(dir, 'settings.json')
      if (!existsSync(settingsPath)) {
        writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: {} }, null, 2))
      }
      return dir
    } catch { /* try next */ }
  }
  return tmpdir()
}

// --- Daily digest ---
//
// Generates a short Hungarian summary of the day's memories for the main agent
// and stores it in the daily log. After the NoA rewrite (slim noa.db schema,
// Telegram-decoupled) the digest reads agent-scoped memories via noa-memory and
// writes the summary through appendDailyLog (daily_logs table) -- the legacy
// chat-scoped getMemoriesForChat + saveMemory('episodic') path is retired
// ('episodic' is not a slim-schema category). The summary is retrievable via the
// daily-log read path (recallByDateRange == GET /api/daily-log).
export async function runDailyDigest(): Promise<string | null> {
  // Collect the main agent's memories from the last 24h.
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400
  const recent = getAgentMemories(MAIN_AGENT_ID, 50)
  const todayMemories = recent.filter((m) => m.created_at >= oneDayAgo)

  if (todayMemories.length < 2) {
    logger.info({ count: todayMemories.length }, 'Napi naplo: tul keves emlek, kihagyjuk')
    return null
  }

  // Each memory is wrapped individually: the stored content may have originated
  // from a third party (a forwarded message, a quoted email). Treat every
  // record as data, not instructions.
  const memoryLines = todayMemories
    .map((m) => `- ${wrapUntrusted('memory-record', m.content.slice(0, 200))}`)
    .join('\n')

  const prompt = `${UNTRUSTED_PREAMBLE}
Az alabbi egy AI asszisztens mai emlekei egy felhasznaloval folytatott beszelgetesekbol.
Irj egy tomor napi osszefoglalot (max 5-8 mondat), ami megragadja:
1. Milyen feladatokon dolgoztak
2. Milyen fontos dontesek szulettek
3. Mi maradt nyitva / mi a kovetkezo lepes

Csak az osszefoglalot add vissza, semmi mast. Magyarul irj.

Mai emlekek:
${memoryLines}`

  try {
    const digestCwd = ensureDigestCwd()
    const digestConfigDir = ensureDigestConfigDir()
    const { text } = await runAgent(prompt, undefined, undefined, false, digestCwd, {
      CLAUDE_CONFIG_DIR: digestConfigDir,
    })
    if (!text) return null

    const digest = text.trim()
    const today = new Date().toLocaleDateString('hu-HU')
    appendDailyLog(MAIN_AGENT_ID, `[Napi naplo ${today}] ${digest}`)
    logger.info({ digestCwd, digestConfigDir }, `Napi naplo mentve: ${today}`)
    return digest
  } catch (err) {
    logger.error({ err }, 'Napi naplo generalas hiba')
    return null
  }
}
