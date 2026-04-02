import fs from 'fs';
import path from 'path';

import type { ResultStatus } from '../../core/results.js';
import type { TraceEvent } from '../../core/traces.js';
import { sessionRunnerFixture, taskRunnerFixture } from './fixtures.js';
import { validateAdapterManifest, type AdapterKind, type AdapterManifest, type AdapterManifestValidationResult } from './manifest.js';
import type { AdapterRunnerInput, AdapterRunnerOutput } from './protocol.js';
import { executeAdapterRunner } from './runner.js';

export interface LoadedAdapterManifest {
  adapterPath: string;
  adapterDir: string;
  manifestPath: string;
  entryPath: string;
  raw: unknown;
  schema: AdapterManifestValidationResult;
  manifest?: AdapterManifest;
}

export interface AdapterExecutionCheck {
  mode: 'task' | 'session';
  ok: boolean;
  command?: string[];
  output?: AdapterRunnerOutput;
  stdout?: string;
  stderr?: string;
  errors: string[];
  warnings: string[];
}

export interface AdapterValidationReport {
  ok: boolean;
  adapterPath: string;
  manifestPath?: string;
  entryPath?: string;
  manifestValidation: AdapterManifestValidationResult;
  entryValidation: {
    ok: boolean;
    errors: string[];
    warnings: string[];
  };
  executionChecks: AdapterExecutionCheck[];
}

const VALID_RESULT_STATUSES: ResultStatus[] = [
  'ok',
  'unresolved',
  'timeout',
  'agent_error',
  'provider_error',
  'infra_error',
  'invalid_adapter',
  'unsupported_capability',
  'benchmark_error',
];

export async function loadAdapterManifest(adapterPath: string): Promise<LoadedAdapterManifest> {
  const resolvedPath = path.resolve(adapterPath);
  const stats = await fs.promises.stat(resolvedPath).catch(() => null);
  if (!stats) {
    throw new Error(`Adapter path does not exist: ${resolvedPath}`);
  }

  const adapterDir = stats.isDirectory() ? resolvedPath : path.dirname(resolvedPath);
  const manifestPath = stats.isDirectory()
    ? path.join(resolvedPath, 'adapter.manifest.json')
    : resolvedPath;

  const rawText = await fs.promises.readFile(manifestPath, 'utf-8').catch(() => null);
  if (rawText === null) {
    throw new Error(`Could not read adapter manifest: ${manifestPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (error: any) {
    throw new Error(`Adapter manifest is not valid JSON: ${error?.message || error}`);
  }

  const schema = validateAdapterManifest(raw);
  const entryPath = schema.manifest
    ? path.resolve(adapterDir, schema.manifest.entry)
    : path.resolve(adapterDir, 'missing-entry');

  return {
    adapterPath: resolvedPath,
    adapterDir,
    manifestPath,
    entryPath,
    raw,
    schema,
    manifest: schema.manifest,
  };
}

async function validateEntry(kind: AdapterKind, entryPath: string): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const stats = await fs.promises.stat(entryPath).catch(() => null);
  if (!stats || !stats.isFile()) {
    errors.push(`Adapter entry does not exist: ${entryPath}`);
    return { ok: false, errors, warnings };
  }

  if (kind === 'cli' && (stats.mode & 0o111) === 0) {
    errors.push(`CLI adapter entry is not executable: ${entryPath}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

function isTraceEvent(value: unknown): value is TraceEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string'
    && typeof record.ts === 'string'
    && typeof record.source === 'string'
    && (record.stepId === undefined || (typeof record.stepId === 'number' && Number.isFinite(record.stepId)));
}

function validateRunnerOutputShape(
  output: unknown,
  mode: 'task' | 'session',
  manifest: AdapterManifest
): { ok: boolean; errors: string[]; warnings: string[]; normalized?: AdapterRunnerOutput } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return {
      ok: false,
      errors: ['Runner output must be a JSON object.'],
      warnings,
    };
  }

  const candidate = output as Record<string, unknown>;
  if (typeof candidate.ok !== 'boolean') {
    errors.push('Runner output must include boolean field "ok".');
  }
  if (typeof candidate.status !== 'string' || !VALID_RESULT_STATUSES.includes(candidate.status as ResultStatus)) {
    errors.push(`Runner output must include valid "status". Expected one of: ${VALID_RESULT_STATUSES.join(', ')}.`);
  }
  if (typeof candidate.elapsedMs !== 'number' || !Number.isFinite(candidate.elapsedMs) || candidate.elapsedMs < 0) {
    errors.push('Runner output must include non-negative numeric field "elapsedMs".');
  }
  if (candidate.artifacts !== undefined) {
    if (!Array.isArray(candidate.artifacts)) {
      errors.push('Runner output field "artifacts" must be an array when provided.');
    } else {
      for (const artifact of candidate.artifacts) {
        if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
          errors.push('Each artifact must be an object.');
          continue;
        }
        const artifactRecord = artifact as Record<string, unknown>;
        if (typeof artifactRecord.kind !== 'string' || typeof artifactRecord.path !== 'string') {
          errors.push('Each artifact must include string fields "kind" and "path".');
        }
      }
    }
  }
  if (candidate.trace !== undefined) {
    if (!candidate.trace || typeof candidate.trace !== 'object' || Array.isArray(candidate.trace)) {
      errors.push('Runner output field "trace" must be an object when provided.');
    } else {
      const traceRecord = candidate.trace as Record<string, unknown>;
      if (traceRecord.normalized !== undefined) {
        if (!Array.isArray(traceRecord.normalized)) {
          errors.push('Runner output field "trace.normalized" must be an array when provided.');
        } else if (traceRecord.normalized.some((event) => !isTraceEvent(event))) {
          errors.push('Each item in "trace.normalized" must include string fields "type", "ts", "source", and optional numeric "stepId".');
        }
      }
      if (traceRecord.native !== undefined) {
        if (!Array.isArray(traceRecord.native)) {
          errors.push('Runner output field "trace.native" must be an array when provided.');
        } else {
          for (const traceArtifact of traceRecord.native) {
            if (!traceArtifact || typeof traceArtifact !== 'object' || Array.isArray(traceArtifact)) {
              errors.push('Each native trace entry must be an object.');
              continue;
            }
            const nativeRecord = traceArtifact as Record<string, unknown>;
            if (typeof nativeRecord.kind !== 'string' || typeof nativeRecord.path !== 'string') {
              errors.push('Each native trace entry must include string fields "kind" and "path".');
            }
          }
        }
      }
    }
  }

  if (mode === 'session' && candidate.ok === true && typeof candidate.action !== 'string' && typeof candidate.finalText !== 'string') {
    warnings.push('Session runner output should usually include "action" or "finalText".');
  }

  if (!manifest.capabilities.supportsPatchOutput && typeof candidate.patch === 'string' && candidate.patch.trim()) {
    warnings.push('Runner returned a patch but manifest.capabilities.supportsPatchOutput is false.');
  }
  if (!manifest.capabilities.supportsTrajectory && candidate.trace) {
    warnings.push('Runner returned trace data but manifest.capabilities.supportsTrajectory is false.');
  }
  const normalizedTrace = candidate.trace && typeof candidate.trace === 'object' && !Array.isArray(candidate.trace)
    ? (candidate.trace as { normalized?: TraceEvent[] }).normalized
    : undefined;
  if (!manifest.capabilities.supportsToolCallTrace && Array.isArray(normalizedTrace)) {
    const hasToolTrace = normalizedTrace.some((event) => event.type.toLowerCase().includes('tool'));
    if (hasToolTrace) {
      warnings.push('Runner returned tool trace events but manifest.capabilities.supportsToolCallTrace is false.');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    normalized: candidate as unknown as AdapterRunnerOutput,
  };
}

async function executeFixture(
  manifest: AdapterManifest,
  entryPath: string,
  input: AdapterRunnerInput
): Promise<AdapterExecutionCheck> {
  const command = manifest.kind === 'cli'
    ? [entryPath]
    : manifest.kind === 'python'
      ? ['python3', entryPath]
      : ['node', entryPath];
  const check: AdapterExecutionCheck = {
    mode: input.mode,
    ok: false,
    command,
    errors: [],
    warnings: [],
  };

  const result = await executeAdapterRunner(manifest, entryPath, input, path.dirname(entryPath));

  check.stdout = result.stdout;
  check.stderr = result.stderr;

  if (result.error && result.exitCode !== 0) {
    check.errors.push(`Runner exited with code ${result.exitCode}: ${result.error}`);
    return check;
  }

  if (!result.output) {
    check.errors.push(result.error || 'Runner did not produce a valid output payload.');
    return check;
  }

  const outputValidation = validateRunnerOutputShape(result.output, input.mode, manifest);
  check.errors.push(...outputValidation.errors);
  check.warnings.push(...outputValidation.warnings);
  check.output = outputValidation.normalized;
  check.ok = check.errors.length === 0;
  return check;
}

export async function validateAdapter(adapterPath: string): Promise<AdapterValidationReport> {
  const loaded = await loadAdapterManifest(adapterPath);
  const entryValidation = loaded.manifest
    ? await validateEntry(loaded.manifest.kind, loaded.entryPath)
    : {
        ok: false,
        errors: ['Manifest validation failed; entry validation skipped.'],
        warnings: [],
      };

  const executionChecks: AdapterExecutionCheck[] = [];
  if (loaded.manifest && entryValidation.ok) {
    if (loaded.manifest.capabilities.runModes.includes('task')) {
      executionChecks.push(await executeFixture(loaded.manifest, loaded.entryPath, taskRunnerFixture));
    }
    if (loaded.manifest.capabilities.runModes.includes('session')) {
      executionChecks.push(await executeFixture(loaded.manifest, loaded.entryPath, sessionRunnerFixture));
    }
  }

  return {
    ok: loaded.schema.ok && entryValidation.ok && executionChecks.every((check) => check.ok),
    adapterPath: loaded.adapterPath,
    manifestPath: loaded.manifestPath,
    entryPath: loaded.manifest ? loaded.entryPath : undefined,
    manifestValidation: loaded.schema,
    entryValidation,
    executionChecks,
  };
}
