#!/usr/bin/env python3
"""
Obsidian vault mirror for the NoA fleet knowledge base.

Read-only mirror: the source of truth stays the noa.db memory system + daily-log.
This script pulls cold + shared memories and the daily log via the dashboard API
and renders a browsable, wiki-linked Obsidian vault. Safe to re-run (idempotent):
it rewrites the generated files under Memories/ and Daily Log/ each run.

Layout produced:
  NoA-Vault/
    Home.md                     -- map of content (agent + date index)
    Memories/
      Cold/<agent>.md           -- lessons / decisions / archive
      Shared/<agent>.md         -- cross-agent relevant knowledge
    Daily Log/<date>.md         -- fleet-wide journal, merged per day

Usage: python3 scripts/obsidian-vault-sync.py
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from collections import defaultdict
from datetime import datetime, timezone, timedelta

API = "http://localhost:3420"
VAULT = "/mnt/c/Users/domin/Documents/NoA-Vault"
TOKEN_FILE = os.path.join(os.path.dirname(__file__), "..", "store", ".dashboard-token")
BUDAPEST = timezone(timedelta(hours=2))  # CEST; display only

with open(TOKEN_FILE) as f:
    TOKEN = f.read().strip()


def api(path, retries=6):
    req = urllib.request.Request(API + path, headers={"Authorization": f"Bearer {TOKEN}"})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                time.sleep(0.15)  # gentle throttle to stay under the rate limit
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
    raise RuntimeError("unreachable")


def slug(s):
    return re.sub(r"[^\w\- ]", "", s).strip()


def fmt_ts(epoch):
    if not epoch:
        return ""
    try:
        return datetime.fromtimestamp(int(epoch), BUDAPEST).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return ""


def fmt_date(epoch):
    """ISO date (YYYY-MM-DD) so Obsidian parses it as a Date property (Bases-queryable)."""
    if not epoch:
        return ""
    try:
        return datetime.fromtimestamp(int(epoch), BUDAPEST).strftime("%Y-%m-%d")
    except Exception:
        return ""


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


# Fixed property-type registry: date fields as Date, count as Number, tags as Tags.
# This is the "global property types" drift-guard (research-obsidian-deep-0730.md #4.1)
# done natively -- no Linter plugin needed for the generated notes.
PROPERTY_TYPES = {
    "date": "date",
    "updated": "date",
    "count": "number",
    "agent": "text",
    "tier": "text",
    "type": "text",
    "tags": "tags",
    "generated": "checkbox",
}


def ensure_property_types(vault):
    """Merge our property types into .obsidian/types.json without clobbering existing ones."""
    cfg_dir = os.path.join(vault, ".obsidian")
    if not os.path.isdir(cfg_dir):
        return  # vault not opened in Obsidian yet; skip silently
    path = os.path.join(cfg_dir, "types.json")
    data = {}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception:
            data = {}
    types = data.setdefault("types", {})
    changed = False
    for k, v in PROPERTY_TYPES.items():
        if types.get(k) != v:
            types[k] = v  # our generated schema owns these keys
            changed = True
    if changed:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)


# Bases (.base) files: no-code, queryable database views over the generated notes.
# Minimal schema validated against obsidianmd/obsidian-help (filters + properties + views).
BASES = {
    "Memories": """filters:
  and:
    - 'type == "memory"'
properties:
  agent:
    displayName: Agent
  tier:
    displayName: Tier
  count:
    displayName: Darab
  date:
    displayName: Utolso
  updated:
    displayName: Szinkron
views:
  - type: table
    name: Memoriak
    order:
      - agent
      - tier
      - count
      - date
""",
    "Daily Log": """filters:
  and:
    - 'type == "daily-log"'
properties:
  date:
    displayName: Nap
  count:
    displayName: Bejegyzes
views:
  - type: table
    name: Napi naplo
    order:
      - date
      - count
""",
    "Knowledge": """filters:
  and:
    - 'generated == true'
properties:
  type:
    displayName: Tipus
  agent:
    displayName: Agent
  date:
    displayName: Datum
  count:
    displayName: Darab
views:
  - type: table
    name: Minden generalt jegyzet
    order:
      - type
      - agent
      - date
      - count
""",
}


def write_bases(vault):
    for name, body in BASES.items():
        write(os.path.join(vault, "Views", f"{name}.base"), body)
    # Short guide on the optional Linter plugin (for hand-edited notes only; the
    # generated notes are already drift-immune via the script + types.json).
    readme = (
        "# Views\n\n"
        "No-code Bases tablak a generalt jegyzeteken (Obsidian 1.9+ kell). "
        "Nyisd meg a `.base` fajlokat, vagy agyazd be barmely jegyzetbe egy "
        "` ```base ` kodblokkal.\n\n"
        "## Frontmatter-drift vedelem\n\n"
        "A generalt jegyzetek semaja fix (type/agent/tier/count/date/updated/tags), "
        "es a `.obsidian/types.json` rogziti a property-tipusokat. Ehhez nem kell plugin.\n\n"
        "Ha a jovoben SAJAT (kezzel irt) jegyzeteket is normalizalni akarsz, telepitsd "
        "a **Linter** community plugint (YAML-kulcs rendezes, datum-normalizalas). "
        "A generalt fajlokat ne szerkeszd kezzel - azokat a sync felulirja.\n"
    )
    write(os.path.join(vault, "Views", "README.md"), readme)


def main():
    agents = api("/api/agents")
    if isinstance(agents, dict):
        agents = agents.get("agents", [])
    names = {a.get("name") for a in agents if a.get("name")}
    names.add("marveen")  # orchestrator: has memories but is not in /api/agents
    names = sorted(n for n in names if not n.endswith("-local"))  # skip infra shadows

    cold_by_agent = {}
    shared_by_agent = {}
    daily = defaultdict(list)  # date -> [(agent, content, ts)]

    for name in names:
        try:
            cold = api(f"/api/memories?agent={name}&category=cold")
            shared = api(f"/api/memories?agent={name}&category=shared")
        except Exception as e:
            print(f"  skip {name}: {e}", file=sys.stderr)
            continue
        if cold:
            cold_by_agent[name] = cold
        if shared:
            shared_by_agent[name] = shared
        try:
            dates = api(f"/api/daily-log/dates?agent={name}")
            if isinstance(dates, dict):
                dates = dates.get("dates", [])
            for d in dates or []:
                for entry in api(f"/api/daily-log?agent={name}&date={d}") or []:
                    daily[d].append((name, entry.get("content", ""), entry.get("created_at")))
        except Exception as e:
            print(f"  daily-log skip {name}: {e}", file=sys.stderr)

    stamp = datetime.now(BUDAPEST).strftime("%Y-%m-%d %H:%M")
    today = datetime.now(BUDAPEST).strftime("%Y-%m-%d")

    # --- Memory tier files ---
    def render_mem_file(agent, mems, tier_label):
        # Fixed frontmatter schema (drift-immune types): date/updated unquoted ISO ->
        # Obsidian Date property; count unquoted int -> Number. Bases/Dataview-queryable.
        latest = fmt_date(max((m.get("created_at") or 0) for m in mems)) if mems else ""
        lines = [
            "---",
            "type: memory",
            f"agent: {agent}",
            f"tier: {tier_label.lower()}",
            f"count: {len(mems)}",
            f"date: {latest}",
            f"updated: {today}",
            "tags: [memory, " + tier_label.lower() + "]",
            "generated: true",
            "---",
            f"# {agent} ({tier_label})",
            "",
            f"> Automatikus tükör a NoA memória-rendszerből. Forrás: noa.db. Frissítve: {stamp}.",
            f"> Kapcsolódó: [[{agent} (Shared)]] · [[{agent} (Cold)]] · [[Home]]",
            "",
        ]
        for m in sorted(mems, key=lambda x: x.get("created_at") or 0, reverse=True):
            kw = m.get("keywords") or ""
            tk = m.get("topic_key") or ""
            head = tk or (kw.split(",")[0].strip() if kw else f"memória #{m.get('id')}")
            lines.append(f"## {head}")
            when = fmt_ts(m.get("created_at"))
            meta = []
            if when:
                meta.append(when)
            if kw:
                meta.append("#" + " #".join(slug(k).replace(" ", "-") for k in kw.split(",") if slug(k)))
            if meta:
                lines.append(f"*{' · '.join(meta)}*")
            lines.append("")
            lines.append((m.get("content") or "").strip())
            lines.append("")
        return "\n".join(lines)

    for agent, mems in cold_by_agent.items():
        write(os.path.join(VAULT, "Memories", "Cold", f"{agent} (Cold).md"),
              render_mem_file(agent, mems, "Cold"))
    for agent, mems in shared_by_agent.items():
        write(os.path.join(VAULT, "Memories", "Shared", f"{agent} (Shared).md"),
              render_mem_file(agent, mems, "Shared"))

    # --- Daily log files ---
    for date, entries in daily.items():
        lines = [
            "---",
            "type: daily-log",
            f"date: {date}",
            f"count: {len(entries)}",
            f"updated: {today}",
            "tags: [daily-log]",
            "generated: true",
            "---",
            f"# Napi napló - {date}",
            f"> Flotta-szintű napló. Forrás: noa.db. Frissítve: {stamp}. [[Home]]",
            "",
        ]
        for agent, content, ts in sorted(entries, key=lambda x: x[2] or 0):
            t = fmt_ts(ts)
            lines.append(f"### {agent}" + (f" · {t}" if t else ""))
            lines.append((content or "").strip())
            lines.append("")
        write(os.path.join(VAULT, "Daily Log", f"{date}.md"), "\n".join(lines))

    # --- Home MOC ---
    home = [
        "---",
        "type: moc",
        f"updated: {today}",
        "tags: [moc]",
        "generated: true",
        "---",
        "# NoA - Tudástár",
        "",
        f"> A NoA flotta tudásának böngészhető tükre. Forrás: noa.db (memória-rendszer + napi napló).",
        f"> Automatikusan frissül. Utolsó szinkron: {stamp}.",
        "> A vault csak olvasható tükör (a forrás a DB, ne szerkeszd itt a generált fájlokat).",
        "",
        "## Memóriák - Cold (tanulságok, döntések)",
        "",
    ]
    for agent in sorted(cold_by_agent):
        home.append(f"- [[{agent} (Cold)]] ({len(cold_by_agent[agent])})")
    home += ["", "## Memóriák - Shared (flotta-releváns tudás)", ""]
    for agent in sorted(shared_by_agent):
        home.append(f"- [[{agent} (Shared)]] ({len(shared_by_agent[agent])})")
    home += ["", "## Napi napló", ""]
    for date in sorted(daily, reverse=True):
        home.append(f"- [[{date}]] ({len(daily[date])} bejegyzés)")
    home += [
        "",
        "## Adatnézetek (Bases)",
        "",
        "> Lekérdezhető, no-code táblák a generált jegyzeteken (Obsidian 1.9+). A `Views/` mappában:",
        "- `Memories.base` - memóriák agentenként (tier / darab / dátum)",
        "- `Daily Log.base` - napi napló idővonal (nap / bejegyzésszám)",
        "- `Knowledge.base` - minden generált jegyzet egy táblában (típus szerint)",
        "",
    ]
    write(os.path.join(VAULT, "Home.md"), "\n".join(home))

    # --- Global property types (native drift-guard, no plugin) ---
    # Registers YAML property types so Obsidian parses date/count/tags consistently
    # across 5k+ generated notes. Merge, never clobber the Boss's own choices.
    ensure_property_types(VAULT)

    # --- Bases: no-code queryable views over the generated notes ---
    write_bases(VAULT)

    n_cold = sum(len(v) for v in cold_by_agent.values())
    n_shared = sum(len(v) for v in shared_by_agent.values())
    n_daily = sum(len(v) for v in daily.values())
    print(f"OK: {len(cold_by_agent)} cold-file ({n_cold} mem), "
          f"{len(shared_by_agent)} shared-file ({n_shared} mem), "
          f"{len(daily)} napi-napló-nap ({n_daily} bejegyzés) -> {VAULT}")


if __name__ == "__main__":
    main()
