// Single source of truth for message-priority representation (card 88849f24,
// the A1->B1 cutover gate).
//
// agent_messages.priority migrates from a TEXT enum to INTEGER:
//   low=25  normal=50  high=75  urgent=100   (OQ-4, spec-noa-a1-db-schema.md)
//
// The fleet runs on claudeclaw.db (TEXT priority, CHECK-constrained) until a
// SEPARATE cutover Boss-GO points NOA_DB_PATH at noa.db (INTEGER priority). The
// binary is therefore deployed BEFORE the column type flips. To make the
// transition deploy-order independent, every read normalizes whatever the row
// holds (TEXT or INTEGER) to a canonical integer, and every write emits the
// representation that matches the live column's declared type. No module above
// this one (db.ts, web/*) re-derives the mapping -- they import it from here.

export type MessagePriority = 'low' | 'normal' | 'high' | 'urgent'

// A priority as it may appear in flight: the API/enum string, or the migrated
// integer once the INTEGER column is live.
export type PriorityValue = MessagePriority | number

// Canonical integer for each tier. Strictly increasing with urgency so a plain
// numeric `>=` comparison expresses "at least this urgent".
export const PRIORITY_INT: Record<MessagePriority, number> = {
  low: 25,
  normal: 50,
  high: 75,
  urgent: 100,
}

export const DEFAULT_PRIORITY_INT = PRIORITY_INT.normal

export const MESSAGE_PRIORITIES: readonly MessagePriority[] = ['low', 'normal', 'high', 'urgent']

/** Type guard for the TEXT enum (used by the API validation boundary). */
export function isValidPriorityString(value: unknown): value is MessagePriority {
  return typeof value === 'string' && (MESSAGE_PRIORITIES as readonly string[]).includes(value)
}

/**
 * Canonical integer for any priority representation. A TEXT tier maps via
 * PRIORITY_INT; a finite number passes through unchanged (an off-tier integer
 * is honoured, not snapped, so future granular priorities work); anything else
 * (unknown string, null, undefined, NaN, Infinity) falls back to the normal
 * default -- mirroring the historical "unknown priority behaves as normal" rule.
 */
export function toPriorityInt(value: PriorityValue | null | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : DEFAULT_PRIORITY_INT
  }
  if (isValidPriorityString(value)) return PRIORITY_INT[value]
  return DEFAULT_PRIORITY_INT
}

/**
 * Canonical TEXT tier for any priority representation. A valid tier passes
 * through; an integer buckets to the highest tier whose threshold it reaches
 * (>=100 urgent, >=75 high, >=50 normal, else low); unknown -> normal. Used by
 * the write side when the live column is still TEXT (CHECK-safe).
 */
export function toPriorityString(value: PriorityValue | null | undefined): MessagePriority {
  if (isValidPriorityString(value)) return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= PRIORITY_INT.urgent) return 'urgent'
    if (value >= PRIORITY_INT.high) return 'high'
    if (value >= PRIORITY_INT.normal) return 'normal'
    return 'low'
  }
  return 'normal'
}

/**
 * The value to persist so it matches the live column's storage type:
 * INTEGER column -> canonical integer, TEXT column -> CHECK-safe tier string.
 * Keeps pre-cutover writes inside the TEXT CHECK and post-cutover writes clean
 * integers, while the read path normalizes either way.
 */
export function priorityForColumn(
  value: PriorityValue | null | undefined,
  columnIsInteger: boolean,
): number | MessagePriority {
  return columnIsInteger ? toPriorityInt(value) : toPriorityString(value)
}

/**
 * Whether a column's PRAGMA table_info declared type has INTEGER affinity.
 * Follows SQLite's affinity rule (a declared type CONTAINING "INT" is INTEGER);
 * a missing/empty type defaults to non-integer (TEXT), the safe pre-cutover
 * assumption.
 */
export function columnTypeIsInteger(declaredType: string | null | undefined): boolean {
  return typeof declaredType === 'string' && declaredType.toUpperCase().includes('INT')
}
