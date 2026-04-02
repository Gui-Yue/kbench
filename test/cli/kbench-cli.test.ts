import { describe, expect, it } from 'vitest';

import { runKbench } from '../helpers/cli.js';

describe('kbench CLI', () => {
  it('prints the top-level help with benchmark run contract details', async () => {
    const result = await runKbench(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('kbench benchmark run');
    expect(result.stdout).toContain('swe/tb2 write Harbor results into <run-dir>; tau writes artifacts inside <run-dir>.');
    expect(result.stdout).toContain('GEMINI_API_KEY / GEMINI_BASE_URL / GOOGLE_GEMINI_BASE_URL');
  });

  it('lists all supported benchmarks', async () => {
    const result = await runKbench(['benchmark', 'list']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['swe', 'tb2', 'tau', 'sae']);
  });

  it('rejects unsupported benchmark run workdir forwarding for swe', async () => {
    const result = await runKbench([
      'benchmark',
      'run',
      '--benchmark',
      'swe',
      '--harness',
      'kode-agent-sdk',
      '--model-name',
      'openai/gpt-4.1-mini',
      '--workdir',
      '/tmp',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not support --workdir or --store-dir');
  });

  it('rejects mismatched benchmark run id and run dir for swe', async () => {
    const result = await runKbench([
      'benchmark',
      'run',
      '--benchmark',
      'swe',
      '--harness',
      'kode-agent-sdk',
      '--model-name',
      'openai/gpt-4.1-mini',
      '--run-dir',
      '/tmp/custom-swe-run',
      '--run-id',
      'mismatched',
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires --run-id to match basename(--run-dir) for swe');
  });

  it('reports harness incompatibility for gemini-cli on tau', async () => {
    const result = await runKbench([
      'harness',
      'validate',
      '--harness',
      'gemini-cli',
      '--benchmark',
      'tau',
    ]);

    expect(result.status).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.validation.ok).toBe(false);
    expect(payload.validation.errors).toContain('Harness gemini-cli does not declare support for benchmark tau.');
  });

  it('preserves the explicit SAE run directory even when credentials are missing', async () => {
    const missingIdFile = '/tmp/kbench-missing-sae-agent-id';
    const missingKeyFile = '/tmp/kbench-missing-sae-agent-api-key';
    const result = await runKbench([
      'benchmark',
      'run',
      '--benchmark',
      'sae',
      '--harness',
      'kode-agent-sdk',
      '--model-name',
      'openai/gpt-4.1-mini',
      '--run-dir',
      '/tmp/kbench-sae-cli-test-run',
      '--sae-agent-id-file',
      missingIdFile,
      '--sae-api-key-file',
      missingKeyFile,
    ]);

    expect(result.status).toBe(2);
    const payload = JSON.parse(result.stdout);
    expect(payload.runDir).toBe('/tmp/kbench-sae-cli-test-run');
    expect(payload.benchmarkError.message).toContain(missingIdFile);
    expect(payload.benchmarkError.message).toContain(missingKeyFile);
  });
});
