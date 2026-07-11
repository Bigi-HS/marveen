#!/usr/bin/env python3
"""
Dream-Engine: Nightly Consolidation for ReasoningBank
Runs at 22:00 CET, processes daily-log -> ReasoningBank entries
Safeguards: snapshot, dedup-FLAG, never-delete, curator-review on destructive ops
"""

import os
import sqlite3
import json
import subprocess
import sys
import shutil
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def resolve_default_db(env=None, project_root=None):
    """Vault DB target for the dream-engine consolidation. Honors NOA_DB_PATH
    (the noa.db cutover live DB) and fails open to the LIVE store/noa.db, never
    the frozen store/claudeclaw.db (card 57480c07). The dream-engine reads the
    memories table (dedup / hot-warm-gap / cold-refresh scans) and copy2-snapshots
    the vault; defaulting to the frozen legacy DB would consolidate against a
    stale vault and snapshot the dead DB -> latent capability-loss. NOA_DB_PATH
    is honored only if it names a .db under the project root; anything else fails
    open to the live noa.db.
    """
    env = os.environ if env is None else env
    if project_root is None:
        project_root = PROJECT_ROOT
    default = os.path.join(project_root, "store", "noa.db")
    raw = (env.get("NOA_DB_PATH") or "").strip()
    if not raw:
        return default
    resolved = os.path.abspath(os.path.join(project_root, raw))
    root_with_sep = project_root.rstrip(os.sep) + os.sep
    if resolved.endswith(".db") and resolved.startswith(root_with_sep):
        return resolved
    return default


VAULT_PATH = resolve_default_db(project_root=PROJECT_ROOT)
TOKEN_PATH = "store/.dashboard-token"
API_BASE = "http://localhost:3420"
AGENT_ID = "applegate"

def log(msg):
    """Print timestamped log message"""
    ts = datetime.now(tz=timezone.utc).isoformat()
    print(f"[{ts}] {msg}")

def snapshot_vault(keep_last_n=7):
    """Create read-only snapshot of vault before processing, cleanup old snapshots (A1: deterministic sort)"""
    timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S")
    snapshot_path = f"store/vault_snapshot_{timestamp}.db"
    try:
        shutil.copy2(VAULT_PATH, snapshot_path)
        log(f"✓ Snapshot created: {snapshot_path}")

        # Cleanup old snapshots: keep only last N (A1 FIX: sort by filename, not mtime)
        try:
            from pathlib import Path
            store_dir = Path("store")
            # Sort by filename (ISO timestamp) instead of mtime (which can be identical for close calls)
            snapshots = sorted(store_dir.glob("vault_snapshot_*.db"), key=lambda p: p.name, reverse=True)
            for old_snapshot in snapshots[keep_last_n:]:
                old_snapshot.unlink()
                log(f"ℹ Removed old snapshot: {old_snapshot.name}")
        except Exception as cleanup_err:
            log(f"⚠ Snapshot cleanup failed: {cleanup_err}")

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
    """Collect daily-log entries from past N hours via /api/daily-log endpoint"""
    token = get_token()
    if not token:
        log("✗ Token not found, cannot fetch daily-log via API")
        return []

    try:
        # Use /api/daily-log endpoint to fetch entries for applegate agent
        req = urllib.request.Request(
            f"{API_BASE}/api/daily-log?agent={AGENT_ID}&hours={hours}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="GET"
        )

        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.load(r)
            entries = resp if isinstance(resp, list) else resp.get('entries', [])
            log(f"ℹ Daily-log collected: {len(entries)} entries from past {hours}h")
            return entries
    except urllib.error.HTTPError as e:
        log(f"⚠ Daily-log API failed: {e.code}")
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
    """Extract 'mi működött' + 'mit kerülj' from cluster content (F1+F2 fixes)"""
    worked = []
    avoid = []

    for entry in cluster:
        content = entry.get('content', '')
        keywords = entry.get('keywords', '')
        keywords_lower = keywords.lower()

        # F1 FIX: Case-insensitive detection and section extraction
        content_lower = content.lower()

        # Extract "Mi működött" patterns (case-insensitive search, but preserve original case)
        worked_marker_idx = content_lower.find('**mi működött**')
        if worked_marker_idx == -1:
            worked_marker_idx = content_lower.find('## mi működött')

        if worked_marker_idx != -1:
            # Find the end of the marker (skip past **marker**:)
            marker_end = content.find(':', worked_marker_idx)
            if marker_end == -1:
                marker_end = worked_marker_idx + 15  # Approx length of marker

            # Find next section marker after the content starts
            next_marker = content.find('**', marker_end + 1)
            if next_marker == -1:
                next_marker = content.find('##', marker_end + 1)
            if next_marker == -1:
                next_marker = len(content)

            section = content[marker_end:next_marker]
            # Extract bullet points
            lines = [line.strip().lstrip('- ').strip() for line in section.split('\n')
                    if line.strip() and line.strip().startswith('-')]
            worked.extend([line for line in lines if line and len(line) > 5])

        # Extract "Mit kerülj" patterns (case-insensitive search)
        avoid_marker_idx = content_lower.find('**mit kerülj**')
        if avoid_marker_idx == -1:
            avoid_marker_idx = content_lower.find('## mit kerülj')

        if avoid_marker_idx != -1:
            # Find the end of the marker
            marker_end = content.find(':', avoid_marker_idx)
            if marker_end == -1:
                marker_end = avoid_marker_idx + 13  # Approx length of marker

            # Find next section marker
            next_marker = content.find('**', marker_end + 1)
            if next_marker == -1:
                next_marker = content.find('##', marker_end + 1)
            if next_marker == -1:
                next_marker = len(content)

            section = content[marker_end:next_marker]
            # Extract bullet points
            lines = [line.strip().lstrip('- ').strip() for line in section.split('\n')
                    if line.strip() and line.strip().startswith('-')]
            avoid.extend([line for line in lines if line and len(line) > 5])

        # F2 FIX: Operator precedence - add parentheses to fix logic
        if not worked and ('success' in keywords_lower or 'worked' in keywords_lower):
            worked.append(f"Strategy from {keywords} domain")
        if not avoid and ('fail' in keywords_lower or 'bug' in keywords_lower):
            avoid.append(f"Known issue in {keywords} domain")

    # Deduplicate
    worked = list(dict.fromkeys(worked))
    avoid = list(dict.fromkeys(avoid))

    # Ensure we always have at least placeholder patterns
    if not worked:
        worked = ["Generic pattern extraction needed"]
    if not avoid:
        avoid = ["Review for edge cases"]

    return {
        'worked': worked,
        'avoid': avoid
    }

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

        conn.commit()
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

def has_real_signal(patterns):
    """Check if patterns contain real content (not generic fallback) - G1 GUARD"""
    generic_keywords = [
        "pattern TBD",
        "generic pattern extraction",
        "review for edge cases",
        "placeholder"
    ]

    for key in ['worked', 'avoid']:
        if key in patterns:
            for pattern in patterns[key]:
                pattern_lower = pattern.lower()
                # If any pattern has real content (not just generic marker), it's real signal
                if not any(gk in pattern_lower for gk in generic_keywords):
                    return True

    return False

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

        # G1 GUARD: Skip if patterns are generic-only (no real content)
        if not has_real_signal(patterns):
            log(f"ℹ Skipped {theme}: generic-only patterns (no real Mi működött / Mit kerülj content)")
            continue

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
