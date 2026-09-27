#!/usr/bin/env python3
"""
Vault-Lint TM-1 Auto-Executor

Automatically apply safe (TM-1, <5% FP) tier-migration verdicts from vault-lint L2
to the live noa.db memoria table. Reduces curator load for low-risk shifts.

TM-1: safe, category-only shifts, <5% FP (hot→warm, warm→cold)
TM-2: manual review required (30% FP) — NEVER AUTO-APPLY
TM-3: blocked (schema changes, curator-dependent) — NEVER AUTO-APPLY

Design: Scope-guard against duplicate applier (vault-lint-apply-safe-tm.py, MEM-011).
Checks migration_log for prior applications; already-at-target entries are idempotent no-ops.
Per-item skip (not all-or-rollback) allows independent entries to apply despite bad proposals.
"""

import json
import sqlite3
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
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

    # B1: Duplicate-reconcile guard — check if already applied in migration_log (MEM-011 conflict)
    cursor.execute(
        'SELECT COUNT(*) FROM migration_log WHERE memory_id = ? AND to_tier = ?',
        (entry_id, to_cat)
    )
    count = cursor.fetchone()
    already_applied = count and count[0] > 0
    if already_applied:
        # Idempotent no-op: already in target state via prior applier (MEM-011 or previous run)
        return True, None, (db_id, db_cat, to_cat, db_agent, True)  # True = skip, no-op

    # Verify current category matches proposal (corrupt proposal guard)
    if db_cat != from_cat:
        # Special case: already at target (idempotent no-op, not an error)
        if db_cat == to_cat:
            return True, None, (db_id, db_cat, to_cat, db_agent, True)  # skip
        return False, f"Entry {entry_id} current category {db_cat} != proposal {from_cat}", None

    # Verify agent_id matches (integrity check)
    if db_agent != agent_id:
        return False, f"Entry {entry_id} agent {db_agent} != proposal {agent_id}", None

    # Safety: only allow known migrations
    if (from_cat, to_cat) not in ALLOWED_MIGRATIONS:
        return False, f"Migration {from_cat}→{to_cat} not allowed", None

    return True, None, (db_id, db_cat, to_cat, db_agent, False)  # False = apply


def apply_migrations(proposals):
    """
    Apply validated TM-1 proposals. Per-item skip (not all-or-rollback).

    Returns: (applied_count, failed_count, audit_records, error)
    """
    if not proposals:
        return 0, 0, [], None

    conn = connect_db()
    applied = []
    failed = []
    skipped = 0

    for proposal in proposals:
        try:
            is_valid, error_msg, entry_data = validate_proposal(conn, proposal)

            if not is_valid:
                failed.append({
                    'entry_id': proposal.get('entry_id'),
                    'error': error_msg
                })
                continue

            if not entry_data:
                continue

            db_id, from_cat, to_cat, agent_id, should_skip = entry_data

            if should_skip:
                skipped += 1
                continue

            # B2: Apply migration WITHOUT bumping accessed_at (migration != access)
            conn.execute('BEGIN TRANSACTION')
            cursor = conn.cursor()
            cursor.execute(
                'UPDATE memories SET category = ? WHERE id = ?',
                (to_cat, db_id)
            )

            # Record migration in migration_log (SQLite table, for MEM-011 compat)
            try:
                cursor.execute(
                    '''INSERT INTO migration_log (run_at, memory_id, agent_id, from_tier, to_tier, rule, dry_run)
                       VALUES (unixepoch('now'), ?, ?, ?, ?, 'TM-1', 0)''',
                    (db_id, agent_id, from_cat, to_cat)
                )
            except sqlite3.OperationalError:
                # migration_log table may not exist; catch and skip
                pass

            conn.execute('COMMIT')

            # Build JSON audit record (our sink)
            audit_record = {
                'entry_id': db_id,
                'agent_id': agent_id,
                'from_cat': from_cat,
                'to_cat': to_cat,
                'rule': 'TM-1',
                'applied_at': datetime.now(timezone.utc).isoformat()
            }
            applied.append(audit_record)

        except Exception as e:
            try:
                conn.execute('ROLLBACK')
            except:
                pass
            failed.append({
                'entry_id': proposal.get('entry_id'),
                'error': str(e)
            })

    conn.close()
    return len(applied), len(failed), applied, None


def write_audit_log(audit_records):
    """Append audit records to migration-log-tm1-<YYYY-MM-DD>.json (append-only)."""
    if not audit_records:
        return None

    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    log_file = LOG_DIR / f'migration-log-tm1-{today}.json'

    try:
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
    except Exception as e:
        # Log to stderr (Chad low: audit-gap on write failure)
        print(f"ERROR: write_audit_log failed: {e}", file=sys.stderr)
        return None


def report_to_daily_log(applied_count, failed_count, log_file):
    """Post result to /api/daily-log via urllib (no token in argv)."""
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
        content = f"## TM-1 Executor | Applied: {applied_count}, Failed: {failed_count}\nAudit: {log_file or '(none)'}"

    payload = json.dumps({
        'agent_id': 'applegate',
        'content': content
    })

    try:
        req = urllib.request.Request(
            'http://localhost:3420/api/daily-log',
            data=payload.encode('utf-8'),
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {token}'
            },
            method='POST'
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception as e:
        print(f"ERROR: report_to_daily_log failed: {e}", file=sys.stderr)
        return False


def main():
    """Main entry point."""
    # Load proposals
    proposals = load_proposals()
    if not proposals:
        print("No TM-1 proposals to apply", file=sys.stderr)
        report_to_daily_log(0, 0, None)
        return 0

    # Apply migrations (per-item skip, not all-or-rollback)
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
