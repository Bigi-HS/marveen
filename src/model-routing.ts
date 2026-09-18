/**
 * Quality-gated model routing (ENG-a497f973, HydraFusion-analog).
 *
 * Canonical, dependency-injected logic for the "draft cheap -> gate -> escalate only on
 * gate-fail" pattern. This is the source-of-truth implementation with tests; the Workflow
 * harness cannot import repo modules, so a thin copy-paste snippet mirrors this logic (see
 * docs/design/eng-a497f973-quality-gated-model-routing-spec-0918.md). Any Node-side caller
 * (phantom-eng worker, server code) can import it directly.
 *
 * Reframe (llm-cost-optimizer): the fleet is on a claude.ai subscription, so the objective is
 * reclaiming the Opus WEEKLY QUOTA, not saving dollars. This only wins on workloads that TODAY
 * default to Opus AND where the cheap-model draft passes the gate most of the time; otherwise it
 * is a net loss. It is a targeted wrapper, never a blanket one.
 *
 * Design rule: FAIL-SAFE toward escalation. A false-fail costs Opus quota; a false-pass costs
 * correctness. Correctness wins, so any ambiguity (gate throws, gate uncertain) escalates.
 */

/** Verdict of a quality gate over a draft result. */
export interface RoutedVerdict {
  pass: boolean;
  reason?: string;
}

/** A gate maps a draft to a pass/fail verdict; may be sync or async. */
export type Gate<T> = (draft: T) => RoutedVerdict | Promise<RoutedVerdict>;

/** One routing decision, emitted for measurement (escalation-rate, quality-delta auditing). */
export interface RoutedTelemetry {
  label: string;
  escalated: boolean;
  gatePass: boolean;
  gateReason?: string;
  draftModel?: string;
  escalateModel?: string;
}

export interface RoutedOptions<T> {
  /** Produce the draft on the cheap model (e.g. agent(task, {model: 'sonnet', schema})). */
  draft: () => Promise<T>;
  /** Produce the strong-model answer; invoked ONLY when the gate fails. */
  escalate: () => Promise<T>;
  /** Quality gate over the draft. Schema-validity is assumed handled upstream; this is the
   *  critic-pass (and any extra structural checks, composed via combineGates).
   *  Note: schema-retry is intentionally OUT OF SCOPE here -- the Workflow harness already
   *  auto-retries on schema mismatch via agent({schema}), so a draft reaching this gate is
   *  already schema-valid. This gate judges correctness, not shape. */
  gate: Gate<T>;
  /** Optional telemetry sink; never throws the caller. */
  record?: (t: RoutedTelemetry) => void;
  /** Optional label for telemetry (e.g. 'review:bugs'). */
  label?: string;
  draftModel?: string;
  escalateModel?: string;
}

export interface RoutedResult<T> {
  result: T;
  escalated: boolean;
  gate: RoutedVerdict;
}

/**
 * Draft on the cheap model, run the gate, escalate to the strong model only on gate-fail.
 * Fail-safe: if the gate throws, treat it as a fail and escalate.
 */
export async function routedAgent<T>(opts: RoutedOptions<T>): Promise<RoutedResult<T>> {
  const label = opts.label ?? 'routed';
  const draft = await opts.draft();

  let verdict: RoutedVerdict;
  try {
    verdict = await opts.gate(draft);
  } catch (err) {
    verdict = { pass: false, reason: `gate error: ${errMsg(err)}` };
  }

  const emit = (escalated: boolean): void => {
    // Telemetry is best-effort: a throwing sink must never propagate to the caller
    // (honors the RoutedOptions.record contract). A lost metric is acceptable; a
    // crashed routing decision is not.
    try {
      opts.record?.({
        label,
        escalated,
        gatePass: verdict.pass,
        gateReason: verdict.reason,
        draftModel: opts.draftModel,
        escalateModel: opts.escalateModel,
      });
    } catch {
      /* swallow: telemetry failure never breaks the routed call */
    }
  };

  if (verdict.pass) {
    emit(false);
    return { result: draft, escalated: false, gate: verdict };
  }

  const escalated = await opts.escalate();
  emit(true);
  return { result: escalated, escalated: true, gate: verdict };
}

/**
 * AND-combine gates (e.g. a structural population check AND a critic-pass). Short-circuits on the
 * first failing gate. Fail-safe: a member gate that throws makes the combined gate fail.
 */
export function combineGates<T>(...gates: Gate<T>[]): Gate<T> {
  return async (draft: T): Promise<RoutedVerdict> => {
    for (const g of gates) {
      let v: RoutedVerdict;
      try {
        v = await g(draft);
      } catch (err) {
        return { pass: false, reason: `gate error: ${errMsg(err)}` };
      }
      if (!v.pass) return v;
    }
    return { pass: true };
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
