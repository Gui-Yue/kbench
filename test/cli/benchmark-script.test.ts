import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildBenchmarkScriptSpec } from '../../src/cli/benchmark-script.js';

describe('benchmark script spec', () => {
  const repoRoot = '/tmp/kbench-repo';

  it('maps SWE benchmark runs to Harbor env and output layout', () => {
    const spec = buildBenchmarkScriptSpec(
      repoRoot,
      {
        benchmark: 'swe',
        harness: 'kode-agent-sdk',
        modelName: 'glm/glm-5',
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        runId: 'ignored-by-run-dir',
        runDir: '/tmp/.kbench/runs/swe-123',
      },
      {}
    );

    expect(spec.scriptPath).toBe(path.join(repoRoot, 'scripts', 'bench', 'run-harbor-benchmark.sh'));
    expect(spec.env.MODEL_NAME).toBe('glm/glm-5');
    expect(spec.env.KBENCH_HARNESS).toBe('kode-agent-sdk');
    expect(spec.env.DATASET_NAME).toBe('swebench-verified');
    expect(spec.env.DATASET_VERSION).toBe('1.0');
    expect(spec.env.KBENCH_BENCHMARK).toBe('swe');
    expect(spec.env.OUTPUT_DIR).toBe('/tmp/.kbench/runs');
    expect(spec.env.RUN_ID).toBe('swe-123');
    expect(spec.env.OPENAI_BASE_URL).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
  });

  it('maps TB2 benchmark runs to Harbor with terminal-bench dataset', () => {
    const spec = buildBenchmarkScriptSpec(
      repoRoot,
      {
        benchmark: 'tb2',
        harness: 'kode-agent-sdk',
        modelName: 'openai/gpt-4.1-mini',
        runId: 'tb2-456',
        runDir: '/tmp/.kbench/runs/tb2-456',
      },
      {}
    );

    expect(spec.scriptPath).toBe(path.join(repoRoot, 'scripts', 'bench', 'run-harbor-benchmark.sh'));
    expect(spec.env.DATASET_NAME).toBe('terminal-bench');
    expect(spec.env.DATASET_VERSION).toBe('2.0');
    expect(spec.env.KBENCH_BENCHMARK).toBe('tb2');
    expect(spec.env.OUTPUT_DIR).toBe('/tmp/.kbench/runs');
    expect(spec.env.RUN_ID).toBe('tb2-456');
  });

  it('maps Tau benchmark runs to the tau shell bridge and preserves run dir', () => {
    const spec = buildBenchmarkScriptSpec(
      repoRoot,
      {
        benchmark: 'tau',
        harness: 'kode-agent-sdk',
        modelName: 'anthropic/claude-sonnet-4-5',
        baseUrl: 'https://anthropic-proxy.local',
        runId: 'tau-789',
        runDir: '/tmp/.kbench/runs/tau-789',
      },
      { NO_REBUILD: '0' }
    );

    expect(spec.scriptPath).toBe(path.join(repoRoot, 'scripts', 'bench', 'run-tau-benchmark.sh'));
    expect(spec.env.RUN_ID).toBe('tau-789');
    expect(spec.env.OUTPUT_DIR).toBe('/tmp/.kbench/runs/tau-789');
    expect(spec.env.ANTHROPIC_BASE_URL).toBe('https://anthropic-proxy.local');
    expect(spec.env.NO_REBUILD).toBe('0');
  });
});
