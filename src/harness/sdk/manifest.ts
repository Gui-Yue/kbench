import type { BenchmarkId, HarnessCapability } from '../../core/protocol.js';
import { validateHarnessSelection } from '../selection.js';
import type { HarnessDescriptor } from '../types.js';

export type AdapterKind = 'cli' | 'python' | 'node';

export interface AdapterManifest {
  schemaVersion: 'kbench.adapter/v1';
  id: string;
  kind: AdapterKind;
  entry: string;
  version: string;
  supportedBenchmarks?: BenchmarkId[];
  capabilities: HarnessCapability;
}

export interface AdapterManifestValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest?: AdapterManifest;
}

const VALID_BENCHMARKS: BenchmarkId[] = ['swe', 'tb2', 'tau', 'sae'];
const VALID_KINDS: AdapterKind[] = ['cli', 'python', 'node'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCapabilityMap(value: unknown): value is HarnessCapability {
  if (!isRecord(value)) return false;
  return Array.isArray(value.runModes)
    && value.runModes.every((mode) => mode === 'task' || mode === 'session')
    && typeof value.machineReadableStdout === 'boolean'
    && typeof value.supportsPatchOutput === 'boolean'
    && typeof value.supportsTrajectory === 'boolean'
    && typeof value.supportsToolCallTrace === 'boolean'
    && typeof value.supportsResume === 'boolean'
    && typeof value.supportsImages === 'boolean'
    && typeof value.supportsSandboxBridge === 'boolean'
    && typeof value.supportsPromptTemplate === 'boolean';
}

export function validateAdapterManifest(input: unknown): AdapterManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(input)) {
    return {
      ok: false,
      errors: ['Adapter manifest must be a JSON object.'],
      warnings,
    };
  }

  if (input.schemaVersion !== 'kbench.adapter/v1') {
    errors.push('schemaVersion must be "kbench.adapter/v1".');
  }
  if (!isNonEmptyString(input.id)) {
    errors.push('id must be a non-empty string.');
  }
  if (!isNonEmptyString(input.entry)) {
    errors.push('entry must be a non-empty string.');
  }
  if (!isNonEmptyString(input.version)) {
    errors.push('version must be a non-empty string.');
  }
  if (!VALID_KINDS.includes(input.kind as AdapterKind)) {
    errors.push(`kind must be one of: ${VALID_KINDS.join(', ')}.`);
  }
  if (!isCapabilityMap(input.capabilities)) {
    errors.push('capabilities must be a complete HarnessCapability object.');
  }

  if (input.supportedBenchmarks !== undefined) {
    if (!Array.isArray(input.supportedBenchmarks) || input.supportedBenchmarks.length === 0) {
      errors.push('supportedBenchmarks must be a non-empty array when provided.');
    } else if (input.supportedBenchmarks.some((item) => !VALID_BENCHMARKS.includes(item as BenchmarkId))) {
      errors.push(`supportedBenchmarks may only contain: ${VALID_BENCHMARKS.join(', ')}.`);
    }
  } else {
    warnings.push('supportedBenchmarks is omitted; adapter validation should infer compatibility later.');
  }

  if (isRecord(input.capabilities) && Array.isArray(input.capabilities.runModes) && input.capabilities.runModes.length === 0) {
    errors.push('capabilities.runModes must contain at least one mode.');
  }

  if (
    Array.isArray(input.supportedBenchmarks)
    && input.supportedBenchmarks.length > 0
    && isCapabilityMap(input.capabilities)
  ) {
    const descriptor: HarnessDescriptor = {
      id: isNonEmptyString(input.id) ? input.id : 'adapter',
      kind: VALID_KINDS.includes(input.kind as AdapterKind)
        ? (input.kind as AdapterKind)
        : 'cli',
      description: isNonEmptyString(input.id)
        ? `Adapter manifest for ${input.id}`
        : 'Adapter manifest',
      supportedBenchmarks: input.supportedBenchmarks as BenchmarkId[],
      capabilities: input.capabilities,
    };

    for (const benchmark of descriptor.supportedBenchmarks) {
      const validation = validateHarnessSelection(descriptor, benchmark);
      errors.push(...validation.errors);
      warnings.push(...validation.warnings);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    manifest: errors.length === 0 ? (input as unknown as AdapterManifest) : undefined,
  };
}

export const adapterManifestTemplate: AdapterManifest = {
  schemaVersion: 'kbench.adapter/v1',
  id: 'my-harness',
  kind: 'cli',
  entry: './runner.sh',
  version: '0.1.0',
  supportedBenchmarks: ['swe'],
  capabilities: {
    runModes: ['task'],
    machineReadableStdout: true,
    supportsPatchOutput: true,
    supportsTrajectory: false,
    supportsToolCallTrace: false,
    supportsResume: false,
    supportsImages: false,
    supportsSandboxBridge: false,
    supportsPromptTemplate: false,
  },
};
