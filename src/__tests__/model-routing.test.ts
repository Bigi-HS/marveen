import { describe, it, expect, vi } from 'vitest';
import {
  routedAgent,
  combineGates,
  type RoutedTelemetry,
  type RoutedVerdict,
} from '../model-routing.js';

const PASS: RoutedVerdict = { pass: true };
const FAIL: RoutedVerdict = { pass: false, reason: 'critic found a defect' };

describe('routedAgent', () => {
  it('returns the draft and does NOT escalate when the gate passes', async () => {
    const draft = vi.fn(async () => 'sonnet-draft');
    const escalate = vi.fn(async () => 'opus-answer');

    const out = await routedAgent<string>({
      draft,
      escalate,
      gate: () => PASS,
    });

    expect(out.result).toBe('sonnet-draft');
    expect(out.escalated).toBe(false);
    expect(draft).toHaveBeenCalledTimes(1);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('escalates to the strong model when the gate fails', async () => {
    const draft = vi.fn(async () => 'sonnet-draft');
    const escalate = vi.fn(async () => 'opus-answer');

    const out = await routedAgent<string>({
      draft,
      escalate,
      gate: () => FAIL,
    });

    expect(out.result).toBe('opus-answer');
    expect(out.escalated).toBe(true);
    expect(out.gate.reason).toBe('critic found a defect');
    expect(draft).toHaveBeenCalledTimes(1);
    expect(escalate).toHaveBeenCalledTimes(1);
  });

  it('FAIL-SAFE: a gate that throws escalates (correctness over quota), not silently passes', async () => {
    const draft = vi.fn(async () => 'sonnet-draft');
    const escalate = vi.fn(async () => 'opus-answer');

    const out = await routedAgent<string>({
      draft,
      escalate,
      gate: () => {
        throw new Error('critic crashed');
      },
    });

    expect(out.escalated).toBe(true);
    expect(out.result).toBe('opus-answer');
    expect(out.gate.pass).toBe(false);
    expect(out.gate.reason).toMatch(/gate error/i);
  });

  it('supports an async gate', async () => {
    const out = await routedAgent<string>({
      draft: async () => 'd',
      escalate: async () => 'e',
      gate: async () => PASS,
    });
    expect(out.escalated).toBe(false);
  });

  it('emits telemetry with the escalation decision on the pass path', async () => {
    const records: RoutedTelemetry[] = [];
    await routedAgent<string>({
      label: 'review:bugs',
      draftModel: 'sonnet',
      escalateModel: 'opus',
      draft: async () => 'd',
      escalate: async () => 'e',
      gate: () => PASS,
      record: (t) => records.push(t),
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      label: 'review:bugs',
      escalated: false,
      gatePass: true,
      draftModel: 'sonnet',
      escalateModel: 'opus',
    });
  });

  it('emits telemetry with the escalation decision and reason on the fail path', async () => {
    const records: RoutedTelemetry[] = [];
    await routedAgent<string>({
      label: 'review:perf',
      draft: async () => 'd',
      escalate: async () => 'e',
      gate: () => FAIL,
      record: (t) => records.push(t),
    });

    expect(records[0]).toMatchObject({
      label: 'review:perf',
      escalated: true,
      gatePass: false,
      gateReason: 'critic found a defect',
    });
  });

  it('does not throw if no record sink is provided', async () => {
    await expect(
      routedAgent<string>({ draft: async () => 'd', escalate: async () => 'e', gate: () => PASS }),
    ).resolves.toBeDefined();
  });

  it('a record sink that throws does not propagate to the caller (telemetry is best-effort)', async () => {
    const out = await routedAgent<string>({
      draft: async () => 'd',
      escalate: async () => 'e',
      gate: () => PASS,
      record: () => {
        throw new Error('telemetry backend down');
      },
    });
    // The routed decision still resolves normally despite the sink failure.
    expect(out.result).toBe('d');
    expect(out.escalated).toBe(false);
  });
});

describe('combineGates (schema-check AND critic)', () => {
  it('passes only when every gate passes', async () => {
    const gate = combineGates<string>(
      () => ({ pass: true }),
      () => ({ pass: true }),
    );
    expect(await gate('x')).toMatchObject({ pass: true });
  });

  it('fails and short-circuits on the first failing gate', async () => {
    const second = vi.fn(() => PASS);
    const gate = combineGates<string>(() => FAIL, second);
    const verdict = await gate('x');
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toBe('critic found a defect');
    expect(second).not.toHaveBeenCalled();
  });

  it('FAIL-SAFE: a member gate that throws makes the combined gate fail', async () => {
    const gate = combineGates<string>(
      () => ({ pass: true }),
      () => {
        throw new Error('boom');
      },
    );
    const verdict = await gate('x');
    expect(verdict.pass).toBe(false);
    expect(verdict.reason).toMatch(/gate error/i);
  });
});
