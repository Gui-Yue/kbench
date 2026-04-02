import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseBoolean, runSaeBenchmark } from '../../src/benchmark/sae/runner.js';

describe('SAE runner helpers', () => {
  it('parses common truthy values', () => {
    expect(parseBoolean('true', false)).toBe(true);
    expect(parseBoolean('1', false)).toBe(true);
    expect(parseBoolean('YES', false)).toBe(true);
    expect(parseBoolean('on', false)).toBe(true);
  });

  it('parses common falsy values', () => {
    expect(parseBoolean('false', true)).toBe(false);
    expect(parseBoolean('0', true)).toBe(false);
    expect(parseBoolean('No', true)).toBe(false);
    expect(parseBoolean('off', true)).toBe(false);
  });

  it('falls back when the value is absent or unrecognized', () => {
    expect(parseBoolean(undefined, true)).toBe(true);
    expect(parseBoolean('maybe', false)).toBe(false);
  });

  it('rejects invalid polling configuration before making network requests', async () => {
    await expect(runSaeBenchmark({
      runId: 'sae-invalid-config',
      runDir: path.join(os.tmpdir(), 'kbench-sae-invalid-config'),
      harness: 'kode-agent-sdk',
      modelName: 'openai/gpt-4.1-mini',
      saeApiBase: 'https://www.kaggle.com/api/v1',
      saeAgentIdFile: '~/.kaggle-agent-id',
      saeApiKeyFile: '~/.kaggle-agent-api-key',
      saeRegisterIfMissing: false,
      saeAgentVersion: '1.0',
      saeAgentType: 'kode-agent-sdk',
      saePollIntervalMs: Number.NaN,
    })).rejects.toThrow('saePollIntervalMs must be a positive finite number of milliseconds.');
  });
});
