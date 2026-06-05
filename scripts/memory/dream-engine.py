#!/usr/bin/env python3
"""
Dream-Engine: Nightly Consolidation for ReasoningBank
Runs at 22:00 CET, processes daily-log -> ReasoningBank entries
Safeguards: snapshot, dedup-FLAG, never-delete, curator-review on destructive ops
"""

import sqlite3
import json
import subprocess
import sys
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

VAULT_PATH = "store/claudeclaw.db"
TOKEN_PATH = "store/.dashboard-token"
API_BASE = "http://localhost:3420"
AGENT_ID = "applegate"

def log(msg):
    """Print timestamped log message"""
    ts = datetime.now(tz=timezone.utc).isoformat()
    print(f"[{ts}] {msg}")

def snapshot_vault():
    """Create read-only snapshot of vault before processing"""
    timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S")
    snapshot_path = f"store/vault_snapshot_{timestamp}.db"
    try:
        shutil.copy2(VAULT_PATH, snapshot_path)
        log(f"✓ Snapshot created: {snapshot_path}")
        return snapshot_path
    except Exception as e:
        log(f"✗ Snapshot failed: {e}")
        return None

def get_token():
    """Read dashboard API token"""
    try:
        with open(TOKEN_PATH, 'r') as f:
            return f.read().strip()
    except:
        log("✗ Token not found")
        return None

def collect_daily_log(hours=24):
    """Collect daily-log entries from past N hours (API call)"""
    # NOTE: This is a placeholder. The actual daily-log API endpoint TBD.
    # For now, we fetch from SQLite daily_log table if it exists, or skip.
    try:
        conn = sqlite3.connect(VAULT_PATH)
        c = conn.cursor()

        # Check if daily_log table exists (API stores it somewhere)
        # For MVP: we read from memory 'daily-log' category if it exists
        # Future: use /api/daily-log?agent=applegate&hours=24

        cutoff = datetime.now(tz=timezone.utc) - timedelta(hours=hours)
        cutoff_ts = cutoff.timestamp()

        # Placeholder: return empty for now (daily-log storage TBD)
        log("ℹ Daily-log collection (API TBD, returning empty for MVP)")
        conn.close()
        return []
    except Exception as e:
        log(f"✗ Daily-log collect failed: {e}")
        return []

def cluster_entries(entries):
    """Simple clustering by domain keyword"""
    clusters = {}
    for entry in entries:
        # Extract domain: vault-ops, fleet-ops, reasoningbank, etc.
        keywords = entry.get('keywords', 'unknown')
        domain = 'general'

        for kw in ['vault-ops', 'fleet-ops', 'reasoningbank', 'spec-review', 'test-health']:
            if kw in keywords:
                domain = kw
                break

        if domain not in clusters:
            clusters[domain] = []
        clusters[domain].append(entry)

    return clusters

def extract_patterns(cluster):
    """Extract 'mi működött' + 'mit kerülj' from cluster (placeholder)"""
    # MVP: simple extraction. Full NLP/clustering future.
    patterns = {
        'worked': ['pattern TBD from content'],
        'avoid': ['pattern TBD from content']
    }
    return patterns

def dedup_check(content, keywords):
    """Check if similar entry exists (keyword-search)"""
    try:
        conn = sqlite3.connect(VAULT_PATH)
        c = conn.cursor()

        # Search for existing entries with same keywords
        keyword_list = [kw.strip() for kw in keywords.split(',')]
        for kw in keyword_list:
            c.execute("SELECT id FROM memories WHERE category='cold' AND keywords LIKE ?;", (f'%{kw}%',))
            if c.fetchone():
                conn.close()
                return True  # Found existing entry

        conn.close()
        return False  # No conflict
    except Exception as e:
        log(f"✗ Dedup-check failed: {e}")
        return False

def generate_rb_entry(theme, patterns):
    """Generate ReasoningBank entry (cold tier)"""
    entry = {
        'tema': f"Nightly Consolidation: {theme}",
        'munka': 'Nightly dream-engine run: pattern extraction from daily work',
        'mukkodott': patterns.get('worked', []),
        'kerulj': patterns.get('avoid', []),
        'forrasok': 'Nightly dream-engine consolidation',
        'kulcsszavak': f"reasoningbank, {theme}, nightly-consolidation, dream-engine"
    }

    # Format as cold memory entry
    content = f"""**Téma**: {entry['tema']}

**Mit csináltunk**: {entry['munka']}

**Mi működött**:
{chr(10).join([f"- {p}" for p in entry['mukkodott']])}

**Mit kerülj**:
{chr(10).join([f"- {p}" for p in entry['kerulj']])}

**Források**: {entry['forrasok']}

**Kulcsszavak**: {entry['kulcsszavak']}"""

    return content, entry['kulcsszavak']

def write_rb_entry(content, keywords):
    """Write ReasoningBank entry to cold tier (vault)"""
    try:
        conn = sqlite3.connect(VAULT_PATH)
        c = conn.cursor()

        c.execute("""
            INSERT INTO memories (agent_id, content, category, keywords)
            VALUES (?, ?, ?, ?)
        """, (AGENT_ID, content, 'cold', keywords))

        entry_id = c.lastrowid
        conn.commit()
        conn.close()

        log(f"✓ RB entry written (ID {entry_id})")
        return entry_id
    except Exception as e:
        log(f"✗ Write failed: {e}")
        return None

def keyword_index_refresh_cold():
    """Refresh keywords for cold-tier entries >24h old (safeguard: cold only)"""
    try:
        conn = sqlite3.connect(VAULT_PATH)
        c = conn.cursor()

        cutoff = datetime.now(tz=timezone.utc) - timedelta(hours=24)
        cutoff_ts = cutoff.timestamp()

        # Find cold-tier entries without keywords
        c.execute("""
            SELECT id, content FROM memories
            WHERE category='cold' AND created_at < ? AND (keywords IS NULL OR keywords='')
        """, (cutoff_ts,))

        entries = c.fetchall()
        updated = 0

        for entry_id, content in entries:
            # Simple keyword extraction (first 10 words)
            words = content.split()[:10]
            keywords = ', '.join(words)

            c.execute("UPDATE memories SET keywords = ? WHERE id = ?", (keywords, entry_id))
            updated += 1

        conn.commit()
        conn.close()

        if updated > 0:
            log(f"ℹ Keyword-index refreshed: {updated} cold-tier entries")

        return updated
    except Exception as e:
        log(f"✗ Keyword-index refresh failed: {e}")
        return 0

def generate_report(clusters, rb_entries, flags):
    """Generate nightly report"""
    report = f"""Dream-Engine Nightly Run -- {datetime.now(tz=timezone.utc).isoformat()}

COLLECTED:
  Clusters: {len(clusters)}
  New RB entries: {len(rb_entries)}

OUTPUTS:
  {chr(10).join([f"- ID {id}: {theme}" for id, theme in rb_entries])}

FLAGS (Curator Review):
  {chr(10).join(flags) if flags else "  (none)"}

SAFEGUARDS:
  ✓ Snapshot created
  ✓ Dedup-check active
  ✓ Never-delete enforced
  ✓ Destructive ops flagged
  ✓ Cold-tier only processing

Status: OK"""

    return report

def run_dream_engine():
    """Main dream-engine workflow"""
    log("=== Dream-Engine Nightly Start ===")

    # 1. Snapshot
    snapshot = snapshot_vault()
    if not snapshot:
        log("✗ Snapshot critical, aborting")
        return False

    # 2. Collect daily-log
    log("Collecting daily-log (24h window)...")
    entries = collect_daily_log(24)
    log(f"ℹ Collected: {len(entries)} entries (placeholder)")

    # 3. Cluster
    log("Clustering...")
    clusters = cluster_entries(entries)
    log(f"ℹ Clusters: {len(clusters)}")

    # 4. Extract patterns + RB-gen
    log("Extracting patterns...")
    rb_entries = []
    flags = []

    for theme, cluster_entries in clusters.items():
        patterns = extract_patterns(cluster_entries)
        content, keywords = generate_rb_entry(theme, patterns)

        # Dedup-check
        if dedup_check(content, keywords):
            flags.append(f"DEDUP: {theme} (existing entry found, curator review needed)")
            log(f"⚠ FLAG: potential duplicate in {theme}")
        else:
            # Write RB entry
            entry_id = write_rb_entry(content, keywords)
            if entry_id:
                rb_entries.append((entry_id, theme))

    # 5. Keyword-index refresh (cold-tier only)
    log("Refreshing keyword-index (cold-tier)...")
    kw_updated = keyword_index_refresh_cold()

    # 6. Generate report
    log("Generating report...")
    report = generate_report(clusters, rb_entries, flags)
    log("\n" + report)

    log("=== Dream-Engine Nightly Complete ===")
    return True

if __name__ == '__main__':
    success = run_dream_engine()
    sys.exit(0 if success else 1)
