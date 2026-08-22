#!/usr/bin/env python3
"""
Generate fleet memory concept-index from cold + shared tiers.

Usage: python3 generate-concept-index.py [--output PATH]

Output: store/concept-index.json (ReasoningBank-structured, 110+ entries)
"""
import sqlite3
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

def generate_concept_index(db_path, output_path=None):
    if output_path is None:
        output_path = Path(db_path).parent / "concept-index.json"
    
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    
    # Extract cold + shared memories
    memories = db.execute("""
    SELECT id, agent_id, category, content, keywords, created_at
    FROM memories
    WHERE category IN ('cold', 'shared')
    ORDER BY category DESC, agent_id, created_at DESC
    """).fetchall()
    
    index = []
    for mem in memories:
        entry = {
            "id": mem['id'],
            "source_agent": mem['agent_id'],
            "tier": mem['category'],
            "content_hash": hash(mem['content']) & 0xffffffff,
            "keywords": [k.strip() for k in (mem['keywords'] or '').split(',') if k.strip()],
            "content_preview": mem['content'][:200],
            "created_at": mem['created_at']
        }
        
        # Heuristic: detect ReasoningBank section
        content_lower = mem['content'].lower()
        if any(x in content_lower for x in ['problem', 'issue', 'challenge']):
            entry["section"] = "problem"
        elif any(x in content_lower for x in ['approach', 'solution', 'strategy']):
            entry["section"] = "approach"
        elif any(x in content_lower for x in ['result', 'outcome']):
            entry["section"] = "result"
        elif any(x in content_lower for x in ['lesson', 'learning']):
            entry["section"] = "lesson"
        else:
            entry["section"] = "unstructured"
        
        index.append(entry)
    
    # Write output
    with open(output_path, 'w') as f:
        json.dump({
            "version": "1.0",
            "entries": index,
            "total": len(index),
            "generated_at": datetime.now(timezone.utc).isoformat()
        }, f, indent=2)
    
    db.close()
    return len(index), output_path

def default_db_path():
    """Live DB default (card 57480c07): honor NOA_DB_PATH, fail open to the live
    store/noa.db rather than the frozen legacy claudeclaw.db (this reads the
    memories table)."""
    here = Path(__file__).resolve().parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))
    from db_resolve import resolve_default_db
    return resolve_default_db(project_root=str(here.parent))

if __name__ == "__main__":
    db_path = default_db_path()
    # Anchor the concept-index to the project store/ dir (card c9a543b5 NIT), so a
    # non-store/ NOA_DB_PATH override does not relocate the output alongside the DB.
    output_path = Path(__file__).resolve().parent.parent / "store" / "concept-index.json"

    count, path = generate_concept_index(str(db_path), str(output_path))
    print(f"✓ Generated {count} concept-index entries → {path}")
