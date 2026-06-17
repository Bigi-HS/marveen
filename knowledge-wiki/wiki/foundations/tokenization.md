---
title: "Tokenization (BPE, subword)"
keywords: "tokenization, bpe, subword, vocabulary, byte-pair-encoding"
related:
  - "wiki/foundations/transformer-architecture.md"
created_at: 2026-06-16
updated_at: 2026-06-16
---

## Why subwords

Character-level sequences are too long; word-level vocabularies explode and
cannot represent unseen words. Subword tokenization (BPE, WordPiece, Unigram)
balances vocabulary size against sequence length.

## Byte-pair encoding (BPE)

Start from bytes/characters, then greedily merge the most frequent adjacent
pair, repeating until the target vocabulary size is reached. Rare words split
into multiple known subwords; common words stay whole.

## Practical notes

- Vocabulary size (~32k-128k) trades sequence length against embedding-table
  size.
- Token boundaries affect arithmetic, code, and non-Latin scripts.

## See also

- [Transformer Architecture](transformer-architecture.md)
