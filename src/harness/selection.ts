import type { BenchmarkId, RunMode } from '../core/protocol.js';
import type { HarnessDescriptor } from './types.js';

export interface HarnessSelectionValidation {
  ok: boolean;
  requiredRunMode: RunMode;
  errors: string[];
  warnings: string[];
}

export function getRequiredRunModeForBenchmark(benchmark: BenchmarkId): RunMode {
  return benchmark === 'tau' ? 'session' : 'task';
}

export function validateHarnessSelection(
  descriptor: HarnessDescriptor,
  benchmark: BenchmarkId
): HarnessSelectionValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requiredRunMode = getRequiredRunModeForBenchmark(benchmark);

  if (!descriptor.supportedBenchmarks.includes(benchmark)) {
    errors.push(
      `Harness ${descriptor.id} does not declare support for benchmark ${benchmark}.`
    );
  }

  if (!descriptor.capabilities.runModes.includes(requiredRunMode)) {
    errors.push(
      `Harness ${descriptor.id} does not support required ${requiredRunMode} mode for benchmark ${benchmark}.`
    );
  }

  if (benchmark === 'tau' && descriptor.capabilities.supportsPromptTemplate) {
    warnings.push(
      `Harness ${descriptor.id} supports prompt templates, but tau/session mode should prefer explicit observation/action flow.`
    );
  }

  return {
    ok: errors.length === 0,
    requiredRunMode,
    errors,
    warnings,
  };
}

export function assertHarnessSelection(
  descriptor: HarnessDescriptor,
  benchmark: BenchmarkId
): HarnessSelectionValidation {
  const validation = validateHarnessSelection(descriptor, benchmark);
  if (!validation.ok) {
    throw new Error(validation.errors.join(' '));
  }
  return validation;
}
