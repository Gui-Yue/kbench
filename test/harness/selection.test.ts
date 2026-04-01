import { describe, expect, it } from 'vitest';

import { getHarness, listHarnesses } from '../../src/harness/registry.js';
import { getRequiredRunModeForBenchmark, validateHarnessSelection } from '../../src/harness/selection.js';

describe('harness selection', () => {
  it('maps tau to session mode and swe to task mode', () => {
    expect(getRequiredRunModeForBenchmark('tau')).toBe('session');
    expect(getRequiredRunModeForBenchmark('swe')).toBe('task');
  });

  it('rejects gemini-cli for tau', () => {
    const harness = getHarness('gemini-cli');
    expect(harness).toBeDefined();

    const validation = validateHarnessSelection(harness!, 'tau');
    expect(validation.ok).toBe(false);
    expect(validation.requiredRunMode).toBe('session');
    expect(validation.errors).toContain('Harness gemini-cli does not declare support for benchmark tau.');
    expect(validation.errors).toContain('Harness gemini-cli does not support required session mode for benchmark tau.');
  });

  it('accepts kode-agent-sdk for tau and emits the prompt-template warning', () => {
    const harness = getHarness('kode-agent-sdk');
    expect(harness).toBeDefined();

    const validation = validateHarnessSelection(harness!, 'tau');
    expect(validation.ok).toBe(true);
    expect(validation.requiredRunMode).toBe('session');
    expect(validation.warnings).toContain(
      'Harness kode-agent-sdk supports prompt templates, but tau/session mode should prefer explicit observation/action flow.'
    );
  });

  it('exposes the built-in harness registry', () => {
    const ids = listHarnesses().map((item) => item.id);

    expect(ids).toEqual([
      'kode-agent-sdk',
      'codex',
      'claude-code',
      'gemini-cli',
      'custom-adapter',
    ]);
  });
});
