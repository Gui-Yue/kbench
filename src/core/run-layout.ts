import fs from 'fs';
import path from 'path';

import type { ResultEnvelope, RunMetadata, SummaryResult } from './results.js';

export interface RunLayout {
  runId: string;
  runDir: string;
  runJsonPath: string;
  summaryPath: string;
  outputJsonlPath: string;
  outputErrorsJsonlPath: string;
  logsDir: string;
  instancesDir: string;
}

export function ensureDirFor(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  ensureDirFor(filePath);
  await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  ensureDirFor(filePath);
  await fs.promises.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf-8');
}

export function createRunLayout(runDir: string, runId: string): RunLayout {
  const resolvedRunDir = path.resolve(runDir);
  return {
    runId,
    runDir: resolvedRunDir,
    runJsonPath: path.join(resolvedRunDir, 'run.json'),
    summaryPath: path.join(resolvedRunDir, 'summary.json'),
    outputJsonlPath: path.join(resolvedRunDir, 'output.jsonl'),
    outputErrorsJsonlPath: path.join(resolvedRunDir, 'output_errors.jsonl'),
    logsDir: path.join(resolvedRunDir, 'logs'),
    instancesDir: path.join(resolvedRunDir, 'instances'),
  };
}

export function getInstanceDir(layout: RunLayout, instanceId: string): string {
  return path.join(layout.instancesDir, instanceId);
}

export async function initializeRun(layout: RunLayout, metadata: RunMetadata): Promise<void> {
  fs.mkdirSync(layout.runDir, { recursive: true });
  fs.mkdirSync(layout.logsDir, { recursive: true });
  fs.mkdirSync(layout.instancesDir, { recursive: true });
  await writeJson(layout.runJsonPath, metadata);
}

export async function recordResult(layout: RunLayout, result: ResultEnvelope): Promise<void> {
  const instanceDir = getInstanceDir(layout, result.instanceId);
  fs.mkdirSync(instanceDir, { recursive: true });

  const persistedResult = {
    ...result,
    nativeResult: undefined,
  };

  await writeJson(path.join(instanceDir, 'result.json'), persistedResult);
  if (result.nativeResult !== undefined) {
    await writeJson(path.join(instanceDir, 'native_result.json'), result.nativeResult);
  }

  await appendJsonLine(
    result.ok || result.status === 'unresolved'
      ? layout.outputJsonlPath
      : layout.outputErrorsJsonlPath,
    persistedResult
  );
}

export async function finalizeRun(layout: RunLayout, metadata: RunMetadata, summary: SummaryResult): Promise<void> {
  await writeJson(layout.runJsonPath, metadata);
  await writeJson(layout.summaryPath, summary);
}
