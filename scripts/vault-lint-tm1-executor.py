#!/usr/bin/env python3
"""
Vault-Lint TM-1 Auto-Executor

Automatically apply safe (TM-1, <5% FP) tier-migration verdicts from vault-lint L2
to the live noa.db memoria table. Reduces curator load for low-risk shifts.

TM-1: safe, category-only shifts, <5% FP (hot→warm, warm→cold)
TM-2: manual review required (30% FP) — NEVER AUTO-APPLY
TM-3: blocked (schema changes, curator-dependent) — NEVER AUTO-APPLY
"""

import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

PROPOSALS_FILE = Path('/home/domin/marveen/store/vault-lint-l2-proposals.json')
DB_PATH = Path('/home/domin/marveen/store/noa.db')
LOG_DIR = Path('/home/domin/marveen/store')
ALLOWED_MIGRATIONS = {('hot', 'warm'), ('warm', 'cold')}


def load_proposals():
    """Read TM-1 proposals from vault-lint L2 output."""
    with open(PROPOSALS_FILE) as f:
        data = json.load(f)

    tm1_proposals = [p for p in data.get('tier_migration_proposals', [])
                     if p.get('type') == 'TM-1']
    return tm1_proposals


def connect_db():
    """Connect to noa.db with transaction support."""
    conn = sqlite3.connect(str(DB_PATH))
    conn.isolation_level = None  # autocommit off; use explicit BEGIN/COMMIT
    return conn


def validate_proposal(conn, proposal):
    """
    Validate TM-1 proposal before applying.

    Returns: (is_valid, error_msg, entry_data)
    """
    entry_id = proposal.get('entry_id')
    from_cat = proposal.get('from_category')
    to_cat = proposal.get('to_category')
    agent_id = proposal.get('agent_id')

    # Fetch entry from DB first
    cursor = conn.cursor()
    cursor.execute(
        'SELECT id, category, agent_id FROM memories WHERE id = ?',
        (entry_id,)
    )
    row = cursor.fetchone()

    if not row:
        return False, f"Entry {entry_id} not found in DB", None

    db_id, db_cat, db_agent = row

    # Verify current category matches proposal (corrupt proposal guard) — check before migration validity
    if db_cat != from_cat:
        return False, f"Entry {entry_id} current category {db_cat} != proposal {from_cat}", None

    # Verify agent_id matches (integrity check)
    if db_agent != agent_id:
        return False, f"Entry {entry_id} agent {db_agent} != proposal {agent_id}", None

    # Safety: only allow known migrations
    if (from_cat, to_cat) not in ALLOWED_MIGRATIONS:
        return False, f"Migration {from_cat}→{to_cat} not allowed (not in ALLOWED_MIGRATIONS)", None

    return True, None, (db_id, db_cat, to_cat, db_agent)


def apply_migrations(proposals):
    """
    Apply all validated TM-1 proposals in a single transaction.

    Returns: (applied_count, failed_count, audit_records, error)
    """
    if not proposals:
        return 0, 0, [], None

    conn = connect_db()
    try:
        conn.execute('BEGIN TRANSACTION')

        applied = []
        failed = []

        for proposal in proposals:
            is_valid, error_msg, entry_data = validate_proposal(conn, proposal)

            if not is_valid:
                failed.append({
                    'entry_id': proposal.get('entry_id'),
                    'error': error_msg
                })
                continue

            db_id, from_cat, to_cat, agent_id = entry_data

            # Apply migration
            cursor = conn.cursor()
            cursor.execute(
                'UPDATE memories SET category = ?, accessed_at = unixepoch("now") WHERE id = ?',
                (to_cat, db_id)
            )

            # Build audit record
            audit_record = {
                'entry_id': db_id,
                'agent_id': agent_id,
                'from_cat': from_cat,
                'to_cat': to_cat,
                'rule': 'TM-1',
                'applied_at': datetime.utcnow().isoformat() + 'Z'
            }
            applied.append(audit_record)

        # If any failures, rollback entire transaction (all-or-rollback)
        if failed:
            conn.execute('ROLLBACK')
            return 0, len(failed), [], f"Rolled back: {len(failed)} entries failed validation"

        conn.execute('COMMIT')
        return len(applied), 0, applied, None

    except Exception as e:
        conn.execute('ROLLBACK')
        return 0, len(proposals), [], str(e)
    finally:
        conn.close()


def write_audit_log(audit_records):
    """Append audit records to migration-log-tm1-<YYYY-MM-DD>.json (append-only)."""
    if not audit_records:
        return None

    today = datetime.utcnow().strftime('%Y-%m-%d')
    log_file = LOG_DIR / f'migration-log-tm1-{today}.json'

    # Load existing or create empty
    if log_file.exists():
        with open(log_file) as f:
            existing = json.load(f)
    else:
        existing = []

    # Append new records
    existing.extend(audit_records)

    # Write back
    with open(log_file, 'w') as f:
        json.dump(existing, f, indent=2)

    return str(log_file)


def report_to_daily_log(applied_count, failed_count, log_file):
    """Post result to /api/daily-log."""
    import subprocess
    import os

    token = os.environ.get('GENESIS_AGENT_TOKEN')
    if not token:
        try:
            with open('/home/domin/marveen/store/.dashboard-token') as f:
                token = f.read().strip()
        except:
            return False

    if applied_count == 0 and failed_count == 0:
        content = "## TM-1 Executor | No proposals to apply"
    else:
        content = f"## TM-1 Executor | Applied: {applied_count}, Failed: {failed_count}\nAudit log: {log_file or '(none)'}"

    payload = json.dumps({
        'agent_id': 'applegate',
        'content': content
    })

    try:
        subprocess.run([
            'curl', '-s', '-X', 'POST',
            'http://localhost:3420/api/daily-log',
            '-H', 'Content-Type: application/json',
            '-H', f'Authorization: Bearer {token}',
            '-d', payload
        ], check=True, capture_output=True)
        return True
    except:
        return False


def main():
    """Main entry point."""
    # Load proposals
    proposals = load_proposals()
    if not proposals:
        print("No TM-1 proposals to apply", file=sys.stderr)
        report_to_daily_log(0, 0, None)
        return 0

    # Apply migrations
    applied_count, failed_count, audit_records, error = apply_migrations(proposals)

    if error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1

    # Write audit log
    log_file = write_audit_log(audit_records) if audit_records else None

    # Report to daily log
    report_to_daily_log(applied_count, failed_count, log_file)

    # Print summary
    print(f"TM-1 Executor: {applied_count} applied, {failed_count} failed")
    if log_file:
        print(f"Audit: {log_file}")

    return 0 if failed_count == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
