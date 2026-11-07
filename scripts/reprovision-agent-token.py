#!/usr/bin/env python3
"""
Manual agent token reprovision -- use when sweepAgentTokenRotation fails.

Replicates the TypeScript provisionAgentToken logic (agent-token-provision.ts)
directly in Python so it can be run without starting the server.

Usage:
  python3 scripts/reprovision-agent-token.py <agent_id>

Writes a fresh 0600 token file to agents/<agent_id>/.genesis-token and
revokes all previous tokens for that agent in noa.db.
"""
import hashlib
import json
import os
import secrets
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
DB_PATH = Path(os.environ.get('NOA_DB_PATH', str(REPO_ROOT / 'store' / 'noa.db')))
TTL_MS = 24 * 60 * 60 * 1000  # 24h, matching DEFAULT_AGENT_TOKEN_TTL_MS

STANDARD_SCOPES = [
    'messages:send', 'memory:read', 'memory:write:own',
    'memory:delete:own', 'kanban:read', 'kanban:write',
    'schedules:write', 'dailylog:write:own',
]

SCOPES_BY_AGENT = {
    'marveen':   ['admin'],
    'applegate': STANDARD_SCOPES + ['memory:delete:any'],
    'chad':      STANDARD_SCOPES + ['gate:approve'],
    'thor':      STANDARD_SCOPES + ['gate:approve'],
    'dave':      STANDARD_SCOPES + ['gate:approve', 'gate:ci', 'agents:lifecycle'],
}


def scopes_for(agent_id: str) -> list[str]:
    return SCOPES_BY_AGENT.get(agent_id, STANDARD_SCOPES)


def provision(agent_id: str) -> None:
    token_file = REPO_ROOT / 'agents' / agent_id / '.genesis-token'

    if not token_file.parent.exists():
        raise FileNotFoundError(f'Agent dir not found: {token_file.parent}')
    if token_file.parent.is_symlink():
        raise RuntimeError(f'Parent dir is a symlink -- refusing to write: {token_file.parent}')

    import time
    now_ms = int(time.time() * 1000)
    expires_at_ms = now_ms + TTL_MS
    expires_at_s = expires_at_ms // 1000

    raw_token = secrets.token_hex(32)  # 64 hex chars (32 random bytes)
    token_sha256 = hashlib.sha256(raw_token.encode()).hexdigest()
    scopes_json = json.dumps(scopes_for(agent_id))

    conn = sqlite3.connect(str(DB_PATH))
    try:
        conn.execute('BEGIN')

        # Insert new token
        conn.execute(
            'INSERT INTO agent_tokens (agent_id, token_sha256, scopes_json, created_at, expires_at, revoked_at) '
            'VALUES (?, ?, ?, ?, ?, NULL)',
            (agent_id, token_sha256, scopes_json, now_ms, expires_at_ms)
        )

        # Write token file BEFORE revoking old tokens (atomic swap)
        token_file_content = f'{raw_token}\n{expires_at_s}\n'
        tmp = token_file.with_suffix('.tmp')
        tmp.write_text(token_file_content)
        tmp.chmod(0o600)
        tmp.rename(token_file)

        # Revoke all previous non-revoked tokens except the new one
        revoked = conn.execute(
            'UPDATE agent_tokens SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL AND token_sha256 != ?',
            (now_ms, agent_id, token_sha256)
        ).rowcount

        conn.execute('COMMIT')
    except Exception:
        conn.execute('ROLLBACK')
        # Clean up partial file if it got written
        if token_file.exists():
            pass  # keep the partial write rather than deleting a potentially valid old token
        raise
    finally:
        conn.close()

    import datetime
    exp_dt = datetime.datetime.fromtimestamp(expires_at_s)
    print(f'Token re-provisioned for {agent_id}')
    print(f'  expires: {exp_dt} (in 24h)')
    print(f'  revoked {revoked} old token(s)')
    print(f'  file: {token_file}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python3 scripts/reprovision-agent-token.py <agent_id>', file=sys.stderr)
        sys.exit(1)
    provision(sys.argv[1])
