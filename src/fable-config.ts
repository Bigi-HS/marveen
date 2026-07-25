// Single source of truth for how a Fable-Studio ("fable") model shows up in the
// token_usage telemetry. The ingest side (Forge's collector / wf-noa-001) writes
// token_usage.model with the canonical tag below, and the fable-budget endpoint
// reads it back through the same constant -- so the producer and the consumer can
// never drift (card d1ca8650, Fable safety-net F1).
//
// The value is EMPIRICAL: it is exactly what a fable-configured agent logs in
// token_usage.model today (verified 958 rows, model='claude-fable-5', 2026-07-02
// .. 2026-07-22). Prefix matching keeps a future dated variant
// (e.g. 'claude-fable-5-20260901') in scope without a code change.
export const FABLE_MODEL_TAGS: readonly string[] = ['claude-fable-5']

/** True when a model id belongs to the Fable family (prefix match against the canonical tags). */
export function isFableModel(model: string | null | undefined): boolean {
  if (!model) return false
  return FABLE_MODEL_TAGS.some((tag) => model === tag || model.startsWith(tag))
}
