# Agent Name Registry

Canonical Boss-facing display names for all fleet agents.
This is the single source of truth for `displayName` fields in `agents/*/agent-config.json`
and the root `agent-config.json` (marveen/NoA).

Source: OPS-151 P0 audit, 2026-08-22.
Maintained by: Dave (updates via PR, same AC-P0-2 diff check).

## Canonical mapping

| agent_id       | Boss-facing display name | Notes                                      |
|----------------|--------------------------|--------------------------------------------|
| marveen        | NoA                      | Root agent-config.json. Mixed case.        |
| applegate      | Applegate                |                                            |
| avery          | Avery                    |                                            |
| bellamy        | Bellamy                  |                                            |
| bigben         | Big Ben                  | Two words, space.                          |
| blackbart      | Black Bart               | Two words, space.                          |
| blackbeard     | Blackbeard               |                                            |
| bond           | Bond                     |                                            |
| bonny          | Bonny                    |                                            |
| buster         | Buster                   |                                            |
| chad           | Chad                     |                                            |
| claudia        | Claudia                  |                                            |
| claudia-local  | Claudia Local            | Local inference variant. Two words, space. |
| dave           | Dave                     |                                            |
| devil-advocate | Ördög Ügyvédje           | Hungarian. Hyphenated id.                  |
| forge          | Armorer                  | Remap: id != display.                      |
| gauge          | Dampier                  | Remap: id != display.                      |
| gyore          | Györe                    |                                            |
| heartbeat      | Heartbeat                | System/monitoring agent.                   |
| hibiki         | Hibiki                   |                                            |
| kidd           | Kidd                     |                                            |
| marveen-local  | NoA Local                | Local inference variant. Replaces legacy "GenesisLocal" persona-leak (OPS-151). |
| morgan         | Morgan                   |                                            |
| percy          | Percy                    |                                            |
| quill          | Kalapács                 | Remap: id != display. Hungarian.           |
| rackham        | Rackham                  |                                            |
| radar          | Grace                    | Remap: id != display.                      |
| roberts        | Roberts                  |                                            |
| scout          | Dr. Stone                | Remap: id != display.                      |
| thor           | Thor                     |                                            |
| vane           | Vane                     |                                            |

## AC-P0-2 verification

Run to confirm no agent with a hyphen/underscore in id has displayName == Capitalize(id):

```bash
python3 << 'EOF'
import os, json, re

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
agents_dir = os.path.join(root, 'agents')
violations = []

for agent_id in os.listdir(agents_dir):
    if agent_id.startswith('_'):
        continue
    cfg_path = os.path.join(agents_dir, agent_id, 'agent-config.json')
    if not os.path.isfile(cfg_path):
        continue
    if not ('-' in agent_id or '_' in agent_id):
        continue
    try:
        d = json.load(open(cfg_path))
        dn = d.get('displayName', '')
        capitalize_id = agent_id.capitalize()
        if dn == capitalize_id:
            violations.append(f"FAIL: {agent_id} -> displayName='{dn}' == Capitalize(id)")
    except Exception as e:
        violations.append(f"PARSE_ERR: {agent_id}: {e}")

if violations:
    for v in violations: print(v)
else:
    print("AC-P0-2: PASS -- no violations")
EOF
```
