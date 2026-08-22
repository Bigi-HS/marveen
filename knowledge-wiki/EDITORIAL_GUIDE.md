# Editorial Guide: sources/ -> wiki/

How raw input becomes a canonical wiki entry. Curator: Applegate.

## sources/ (raw archive)

- Minimal editing: fix obvious typos, strip personal/off-topic asides.
- Preserve original organization + timestamps. Do NOT restructure.
- One file per note/transcript, named `<date>-<topic>.md`.
- NO private personal content in the tracked tree -- real private notes are
  gitignored (phase-2). Phase-1 `sources/` holds only generic placeholders.

## wiki/ (canonical knowledge)

1. **Dedup.** If two raw sources cover the same concept, write ONE wiki entry
   that merges them. List both under `sources:`.
2. **Classify.** Place the entry in the right domain:
   `foundations/`, `scaling-laws/`, `training/`, `inference/`, `applications/`.
3. **Frontmatter.** Add the schema block (see `FRONTMATTER_SCHEMA.md`).
4. **Cross-link.** Fill `related:` with sibling entries; add a "See Also"
   section in the body linking the same targets.
5. **Index.** Add the entry to `index.md`: the keyword map row(s) + its domain
   list. Add to `hot-cache.md` only if it is high-salience.
6. **Validate.** `python3 scripts/validate_knowledge_wiki.py knowledge-wiki`
   must pass before commit.

## Linking convention

In-body links use a relative path between entries, e.g. from
`wiki/inference/kv-cache.md` to attention:
`[Attention Mechanism](../foundations/attention-mechanism.md)`. Frontmatter
`related:` uses the wiki-root-relative form
(`wiki/foundations/attention-mechanism.md`).

## Overflow (phase-2)

When a single domain passes ~50 entries, migrate it to a SQLite FTS table
(curator reviews dedup first). Most domains stay markdown; only the largest
overflow. See the spec (`store/karpathy-llm-knowledge-wiki-spec.md`).
