# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for the Genesis fleet.

## What goes here

Significant decisions that are hard to reverse, affect multiple agents, or whose rationale is not obvious from the code. Examples:

- Choosing a transport or protocol (e.g. Tailscale for remote access)
- Accepting a known security tradeoff (e.g. localStorage token storage)
- Architectural patterns adopted or rejected (e.g. RuFlo wholesale vs. pattern-mining)
- Merge gate rules and who must approve what

Small, obvious, or easily reversed decisions do not need an ADR.

## Where else to record decisions

Every ADR should also have a corresponding entry in **cold memory** (category: `cold`, agent: whoever owns the decision area). The ADR is the canonical written record; cold memory makes it searchable across the fleet.

## How to create an ADR

1. Copy `template.md` to `docs/adr/NNN-short-title.md` (NNN = next sequential number, zero-padded to 3 digits).
2. Fill in all sections. Leave none blank -- write "N/A" if truly not applicable.
3. Open a PR to `develop`. The PR goes through the Thor+Dave merge gate (add Chad for security-relevant decisions).
4. Once merged, save a summary to cold memory with keywords matching the decision topic.

## Status values

- `proposed` -- written, not yet reviewed
- `accepted` -- reviewed and adopted
- `rejected` -- reviewed and not adopted (keep the record anyway)
- `superseded by ADR-NNN` -- a later decision replaced this one
