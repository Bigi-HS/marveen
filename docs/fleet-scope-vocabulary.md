# Fleet Scope Vocabulary

_Closed domain-label list for `scope.owns` and `scope.excludes` in agent-config.json._
_AC-S5 (card f31b28a6): every label used in any agent config must appear here._
_Fleet-decided (spec §5); Boss-veto applies. Update via PR + Dave+Thor gate._

## Labels

| Label | Description |
|-------|-------------|
| `orchestration` | Fleet-wide routing, cross-team coordination, Boss escalation |
| `core-eng` | Software engineering: code changes, feature builds, bug fixes |
| `qa-testing` | Quality assurance, test review, test-suite ownership |
| `security-audit` | Security review, vulnerability assessment, gate-SEC seat |
| `deploy-sre` | Deployment, infrastructure, SRE, reliability operations |
| `ci-build` | CI/CD pipelines, build processes, canary validation |
| `research` | Information gathering, web search, knowledge synthesis |
| `monitoring` | Health monitoring, heartbeat checks, fleet alerting |
| `channel-comms` | User-facing communication, Telegram channel management |
| `content-writing` | Writing, documentation, creative content generation |
| `data-analysis` | Analytics, data processing, structured reporting |
| `kanban-ops` | Kanban task management, fleet operations, card routing |
| `gate-review` | Gate-seat ownership, merge approval, review coordination |

## How to extend

To add a new label: open a PR with an entry in this table, gate Dave+Thor.
Labels MUST be kebab-case, lowercase, ASCII only.
