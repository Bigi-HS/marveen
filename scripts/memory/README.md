# Dream-Engine: Nightly Memory Consolidation

Automated nightly job (22:00 CET) that consolidates daily work logs into structured ReasoningBank entries in the Genesis vault.

## Components

- **dream-engine.py**: Main consolidation workflow
  - Snapshot vault (safeguard)
  - Collect daily-log entries
  - Cluster by theme
  - Extract patterns (what worked, what to avoid)
  - Generate ReasoningBank entries (cold tier)
  - Dedup-check (FLAG, no auto-delete)
  - Keyword-index refresh (cold-tier only, >24h)
  - Report generation

- **test_dream_engine.py**: Unit tests
  - Clustering tests
  - Pattern extraction
  - RB entry structure
  - Safeguard verification

## Safeguards (Non-Negotiable)

1. **Snapshot**: Read-only vault copy before processing
2. **Never-Delete**: No deletion operations (dedup = FLAG only)
3. **Dedup-FLAG**: Conflicts flagged for curator review
4. **Cold-Tier Only**: Keyword refresh limited to cold tier + >24h old entries
5. **No Live-Flow Modifications**: Hot/warm entries untouched

## Activation

Currently in MVP/test phase. Live activation requires:

1. Manuális dry-run test (output inspection + safeguard verification)
2. Curator approval
3. Cron registration in tmux supervisor

See: [Fázis 3: Dream-Engine Design Spec](../../store/claudeclaw.db -> Cold Memory ID 142)

## API Dependencies

- Vault: `store/claudeclaw.db` (SQLite)
- Daily-log: TBD (placeholder in MVP, future API integration)
- Dashboard: `store/.dashboard-token` (Bearer auth)

## Usage

```bash
python3 scripts/memory/dream-engine.py
```

Output: Nightly report (console + inter-agent message to marveen)

## Future

- Full daily-log API integration
- Semantic clustering (NLP-based theme detection)
- Dedup-merge automation (curator pre-approval patterns)
- Trend reporting (monthly summaries)
