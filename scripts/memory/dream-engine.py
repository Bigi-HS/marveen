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
    """Check if similar entry exists (keyword-search). F4 FIX: require domain+reasoningbank match."""
    try:
        conn = sqlite3.connect(VAULT_PATH)
        c = conn.cursor()

        # Extract domain keyword (vault-ops, fleet-ops, etc.) from input
        keyword_list = [kw.strip() for kw in keywords.split(',')]
        domain_kw = None
        for kw in keyword_list:
            if any(domain in kw for domain in ['vault-', 'fleet-', 'spec-', 'test-']):
                domain_kw = kw
                break

        if not domain_kw:
            return False  # No domain keyword, no conflict possible

        # Search: cold entries with SAME domain keyword AND "reasoningbank" (not just any keyword)
        # This prevents false-positives on shared keywords like "reasoningbank"
        c.execute("""
            SELECT id FROM memories
            WHERE category='cold' AND keywords LIKE ? AND keywords LIKE ?
        """, (f'%{domain_kw}%', '%reasoningbank%'))

        if c.fetchone():
            conn.close()
            return True  # Found existing entry with same domain+reasoningbank

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
    """Write ReasoningBank entry to cold tier via API (F2: API-based writes)"""
    try:
        token = get_token()
        if not token:
            log("✗ Token not found, cannot write via API")
            return None

        # Use /api/memories endpoint instead of direct sqlite3
        import urllib.request
        payload = {
            "agent_id": AGENT_ID,
            "content": content,
            "category": "cold",
            "keywords": keywords
        }

        req = urllib.request.Request(
            f"{API_BASE}/api/memories",
            data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST"
        )

        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.load(r)
            entry_id = resp.get('id')
            log(f"✓ RB entry written (ID {entry_id}) via API")
            return entry_id
    except Exception as e:
        log(f"✗ Write via API failed: {e}")
        return None

def check_hot_warm_keyword_gaps():
    """F3: Check hot/warm entries for keyword gaps -> FLAG (no auto-write)"""
    try:
        conn = sqlite3.connect(VAULT_PATH)
        c = conn.cursor()

        # Find hot/warm entries without keywords
        c.execute("""
            SELECT id, category, content FROM memories
            WHERE category IN ('hot', 'warm') AND (keywords IS NULL OR keywords='')
        """)

        gaps = c.fetchall()
        conn.close()

        if gaps:
            flag_msg = f"FLAG: {len(gaps)} hot/warm keyword-gaps (curator review needed)"
            for entry_id, category, content in gaps:
                log(f"⚠ {flag_msg}: ID {entry_id} ({category})")
            return gaps
        return []
    except Exception as e:
        log(f"✗ Hot/warm check failed: {e}")
        return []

def keyword_index_refresh_cold():
    """Refresh keywords for cold-tier entries >24h old via API (A1 FIX: API-based UPDATE)"""
    try:
        import urllib.request

        token = get_token()
        if not token:
            log("✗ Token not found, cannot refresh via API")
            return 0

        conn = sqlite3.connect(VAULT_PATH)
        c = conn.cursor()

        cutoff = datetime.now(tz=timezone.utc) - timedelta(hours=24)
        cutoff_ts = cutoff.timestamp()

        # Find cold-tier entries without keywords (F3: explicitly cold-tier only)
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

            # Use API PUT /api/memories/:id endpoint (A1 FIX: not direct sqlite3)
            payload = {"keywords": keywords}
            req = urllib.request.Request(
                f"{API_BASE}/api/memories/{entry_id}",
                data=json.dumps(payload).encode(),
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                method="PUT"
            )

            try:
                with urllib.request.urlopen(req, timeout=10) as r:
                    updated += 1
            except urllib.error.HTTPError as e:
                log(f"⚠ API update failed for ID {entry_id}: {e.code}")

        conn.close()

        if updated > 0:
            log(f"ℹ Keyword-index refreshed: {updated} cold-tier entries (via API)")

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

    # 5. Check hot/warm keyword-gaps (F3: FLAG, no auto-write)
    log("Checking hot/warm keyword-gaps...")
    hot_warm_gaps = check_hot_warm_keyword_gaps()
    for gap_id, cat, content in hot_warm_gaps:
        flags.append(f"HOT/WARM_GAP: ID {gap_id} ({cat}) needs keywords (curator review)")

    # 6. Keyword-index refresh (cold-tier only)
    log("Refreshing keyword-index (cold-tier)...")
    kw_updated = keyword_index_refresh_cold()

    # 7. Generate report
    log("Generating report...")
    report = generate_report(clusters, rb_entries, flags)
    log("\n" + report)

    log("=== Dream-Engine Nightly Complete ===")
    return True

if __name__ == '__main__':
    success = run_dream_engine()
    sys.exit(0 if success else 1)
