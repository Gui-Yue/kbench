import { describe, expect, it } from 'vitest';

import { summarizeResults, type ResultEnvelope } from '../../src/core/results.js';

function makeResult(partial: Partial<ResultEnvelope>): ResultEnvelope {
  return {
    benchmark: 'swe',
    harness: 'kode-agent-sdk',
    instanceId: partial.instanceId || 'case-1',
    ok: partial.ok ?? false,
    status: partial.status || 'agent_error',
    startedAt: partial.startedAt || '2026-01-01T00:00:00.000Z',
    endedAt: partial.endedAt || '2026-01-01T00:00:01.000Z',
    elapsedMs: partial.elapsedMs ?? 1000,
    ...partial,
  };
}

describe('results summary', () => {
  it('summarizes passed, unresolved, and errored counts', () => {
    const summary = summarizeResults('run-1', [
      makeResult({ instanceId: 'a', ok: true, status: 'ok' }),
      makeResult({ instanceId: 'b', ok: false, status: 'unresolved' }),
      makeResult({ instanceId: 'c', ok: false, status: 'timeout' }),
      makeResult({ instanceId: 'd', ok: false, status: 'agent_error' }),
    ]);

    expect(summary.runId).toBe('run-1');
    expect(summary.total).toBe(4);
    expect(summary.passed).toBe(1);
    expect(summary.unresolved).toBe(1);
    expect(summary.errored).toBe(2);
    expect(summary.accuracy).toBe(0.25);
    expect(summary.byStatus).toEqual({
      ok: 1,
      unresolved: 1,
      timeout: 1,
      agent_error: 1,
    });
  });

  it('returns zero accuracy for empty result sets', () => {
    const summary = summarizeResults('empty-run', []);

    expect(summary.total).toBe(0);
    expect(summary.passed).toBe(0);
    expect(summary.unresolved).toBe(0);
    expect(summary.errored).toBe(0);
    expect(summary.accuracy).toBe(0);
    expect(summary.byStatus).toEqual({});
  });
});
