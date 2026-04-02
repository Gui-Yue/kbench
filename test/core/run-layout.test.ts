import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunLayout, finalizeRun, getInstanceDir, initializeRun, recordResult } from '../../src/core/run-layout.js';
import type { ResultEnvelope, RunMetadata } from '../../src/core/results.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function makeTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kbench-run-layout-test-'));
  tempDirs.push(dir);
  return dir;
}

function makeMetadata(runId: string): RunMetadata {
  return {
    runId,
    benchmark: 'swe',
    harness: 'kode-agent-sdk',
    startedAt: '2026-01-01T00:00:00.000Z',
    concurrency: 1,
  };
}

function makeResult(overrides: Partial<ResultEnvelope> = {}): ResultEnvelope {
  return {
    benchmark: 'swe',
    harness: 'kode-agent-sdk',
    instanceId: 'case-1',
    ok: true,
    status: 'ok',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:01.000Z',
    elapsedMs: 1000,
    finalText: 'done',
    nativeResult: { raw: true },
    ...overrides,
  };
}

describe('run layout', () => {
  it('creates deterministic paths for a run directory', () => {
    const layout = createRunLayout('/tmp/kbench-run-layout/example-run', 'example-run');

    expect(layout.runId).toBe('example-run');
    expect(layout.runDir).toBe(path.resolve('/tmp/kbench-run-layout/example-run'));
    expect(layout.runJsonPath).toBe(path.join(layout.runDir, 'run.json'));
    expect(getInstanceDir(layout, 'case-42')).toBe(path.join(layout.runDir, 'instances', 'case-42'));
  });

  it('initializes, records results, and finalizes run artifacts', async () => {
    const root = await makeTempRoot();
    const layout = createRunLayout(path.join(root, 'run-1'), 'run-1');
    const metadata = makeMetadata('run-1');
    const result = makeResult();

    await initializeRun(layout, metadata);
    await recordResult(layout, result);
    await finalizeRun(layout, { ...metadata, endedAt: '2026-01-01T00:00:02.000Z' }, {
      runId: 'run-1',
      total: 1,
      passed: 1,
      unresolved: 0,
      errored: 0,
      accuracy: 1,
      byStatus: { ok: 1 },
    });

    const persistedRun = JSON.parse(await fs.readFile(layout.runJsonPath, 'utf-8'));
    const persistedSummary = JSON.parse(await fs.readFile(layout.summaryPath, 'utf-8'));
    const persistedResult = JSON.parse(await fs.readFile(path.join(layout.instancesDir, 'case-1', 'result.json'), 'utf-8'));
    const persistedNativeResult = JSON.parse(await fs.readFile(path.join(layout.instancesDir, 'case-1', 'native_result.json'), 'utf-8'));
    const outputJsonl = await fs.readFile(layout.outputJsonlPath, 'utf-8');

    expect(persistedRun.endedAt).toBe('2026-01-01T00:00:02.000Z');
    expect(persistedSummary.passed).toBe(1);
    expect(persistedResult.finalText).toBe('done');
    expect(persistedResult.nativeResult).toBeUndefined();
    expect(persistedNativeResult).toEqual({ raw: true });
    expect(outputJsonl.trim()).toContain('"status":"ok"');
  });

  it('writes failing results to output_errors.jsonl', async () => {
    const root = await makeTempRoot();
    const layout = createRunLayout(path.join(root, 'run-err'), 'run-err');

    await initializeRun(layout, makeMetadata('run-err'));
    await recordResult(layout, makeResult({
      ok: false,
      status: 'agent_error',
      instanceId: 'case-err',
      nativeResult: undefined,
    }));

    const outputErrors = await fs.readFile(layout.outputErrorsJsonlPath, 'utf-8');
    expect(outputErrors.trim()).toContain('"status":"agent_error"');
  });
});
