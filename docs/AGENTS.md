# Genesis Fleet Agent Catalog

> Maintained by: Applegate (direct commits to develop for roster updates -- no full gate needed)
> Initial version: Scout, 2026-06-10
> Source of truth: individual `agents/<id>/agent-config.json` + per-agent CLAUDE.md

---

## Agent Table

| id | Display name | Model | Role | Key connections | Trust tier | Reports to |
|----|-------------|-------|------|-----------------|------------|------------|
| marveen | Genesis | claude-sonnet-4-6 | Orchestrator, personal assistant | Telegram (main bot), memory vault (hot/warm/cold/shared), kanban, calendar, email, all MCP servers | orchestrator | Boss (Dominik) |
| dave | Dave | claude-opus-4-8[1m] | Lead engineer | Telegram (@DAVE_KALOZ_BOT), GitHub (PR open/merge), codebase full-write, buster delegation | developer-senior, merge-gate | marveen |
| thor | Thor | claude-sonnet-4-6 | QA peer + merge-gate | Telegram (@Thor_QA_bot), GitHub PR reviews, gauge delegation | developer-senior, merge-gate | marveen |
| avery | Avery | claude-sonnet-4-6 | QA executor | channel-less, test design, coverage analysis | developer-senior | thor |
| bellamy | Bellamy | claude-sonnet-4-6 | QA executor | channel-less, test design, coverage analysis | developer-senior | thor |
| bonny | Bonny | claude-sonnet-4-6 | QA executor | channel-less, test design, coverage analysis | developer-senior | thor |
| vane | Vane | claude-sonnet-4-6 | QA executor | channel-less, test design, coverage analysis | developer-senior | thor |
| chad | Chad | claude-sonnet-4-6 | Security auditor | Telegram, diff analysis (secrets/injection/path-traversal), AIDefence PII filter | developer-senior, security-gate | marveen |
| quill | Quill | claude-sonnet-4-6 | Spec + acceptance criteria writer | channel-less; feeds Quill->Thor->Dave pipeline | researcher | marveen |
| gauge | Gauge | claude-haiku-4-5-20251001 | Test-health monitor | channel-less, PR coverage delta + flaky + trend reports | developer-junior | thor |
| buster | Buster (C12) | claude-haiku-4-5-20251001 | Canary / chameleon sandbox | Telegram (@Buster_TestDummy_bot), isolated test sessions, morphs into target for safe testing | standard | dave, thor |
| applegate | Mrs. Applegate | claude-haiku-4-5-20251001 | Memory curator | memory vault (dedup/tiering/never-delete), ReasoningBank, AGENTS.md event-trigger | developer-junior | marveen |
| scout | Scout | claude-sonnet-4-6 | Research + model-upgrade migration | WebSearch, WebFetch, model monitoring, scheduled heartbeats | researcher | marveen |
| radar | Radar | claude-opus-4-8 | Marketing strategy | Telegram, YT/Twitch/Discord research, art-direction briefs, strategy docs | researcher | marveen |
| bigben | Big Ben | claude-sonnet-4-6 | Content + media production | Telegram (@Big_Ben_photo_bot), ffmpeg, ImageMagick, Meld WS (port 13376), Twitch/YT API | developer-junior | marveen |
| claudia | Claudia | claude-sonnet-4-6 | Personal assistant (PA) | Telegram (@Caudia_secretary_bot), calendar, email, scheduling | developer-senior | marveen |
| forge | Armorer | claude-sonnet-4-6 | DevOps + release | Telegram, build/restart/verify/rollback, post-merge deploy execution | developer-senior | marveen |
| hibiki | Hibiki | claude-sonnet-4-6 | Personal trainer | Telegram, store schema, daily push (token-free cron), evidence-base | developer-senior | marveen |
| heartbeat | Heartbeat | claude-haiku-4-5 | Background monitor (cron) | calendar, email, kanban polling; channel-less, no Telegram | standard | marveen |

---

## Trust Tier Definitions

| Tier | Capabilities | Agents |
|------|-------------|--------|
| orchestrator | Full access, Boss relay, all inter-agent dispatch | marveen |
| developer-senior | Full codebase read/write, PR open+merge-gate, security-flag authority | dave, thor, chad, claudia, forge, hibiki |
| merge-gate | PR approval required to merge to develop/main | dave, thor |
| security-gate | Required reviewers for security/credential PRs | thor, dave, chad |
| developer-junior | Read + limited write, no merge-gate authority | applegate, gauge, bigben |
| researcher | External search/fetch, read codebase, no direct code write | scout, quill, radar |
| standard | Monitor/check only, minimal write (kanban/memory) | heartbeat, buster |

---

## Telegram Channels

| id | Bot handle | Channel type |
|----|-----------|-------------|
| marveen | main Genesis bot | primary orchestration |
| dave | @DAVE_KALOZ_BOT | per-agent |
| thor | @Thor_QA_bot | per-agent |
| buster | @Buster_TestDummy_bot | per-agent |
| claudia | @Caudia_secretary_bot | per-agent |
| radar | Telegram (own bot) | per-agent |
| bigben | @Big_Ben_photo_bot | per-agent |
| hibiki | Telegram (own bot) | per-agent |
| chad | Telegram (own bot) | per-agent |
| forge | Telegram (own bot) | per-agent |

Channel-less (no Telegram bot): quill, gauge, applegate, scout, heartbeat

---

## Security Profiles (from agent-config.json)

| Profile | Agents |
|---------|--------|
| developer-senior | dave, thor, chad, claudia, forge, hibiki |
| developer-junior | applegate, bigben, gauge |
| researcher | scout, quill, radar |
| standard | buster, heartbeat |

---

## Maintenance Notes

- **Owner**: Applegate maintains this file via event-trigger on `agents/*/agent-config.json` changes.
- **Commit policy**: Roster updates (model change, new agent) = direct commit to develop, no full gate needed. Trust-tier changes and structural changes (new columns, trust-tier definitions) = PR through Thor+Dave gate.
- **Scout cross-check**: During model-upgrade migration assessments, Scout reads this file to enumerate fleet scope -- verify it reflects live config before publishing migration plans.
- **Model field**: reflects `agent-config.json` model value at last update. For live model verification use the `/api/agents` dashboard endpoint.
- **Do not edit manually** unless Applegate is unavailable. Flag discrepancies to Applegate via inter-agent message.
