import fs from 'fs';
import path from 'path';

import { resolveMaterializedTargetPath } from './artifacts.js';
import type { TraceRef } from './results.js';

export type TraceSource = 'benchmark' | 'runtime' | 'harness' | 'agent' | 'system';

export interface TraceEvent {
  type: string;
  ts: string;
  stepId?: number;
  source: TraceSource;
  rawRef?: string;
  message?: string;
  role?: string;
  toolName?: string;
  callId?: string;
  extra?: Record<string, unknown>;
}

function ensureTraceDir(instanceDir: string, subdir: 'normalized' | 'native'): string {
  const traceDir = path.join(instanceDir, 'trace', subdir);
  fs.mkdirSync(traceDir, { recursive: true });
  return traceDir;
}

export async function writeNormalizedTrace(instanceDir: string, events: TraceEvent[]): Promise<TraceRef> {
  const traceDir = ensureTraceDir(instanceDir, 'normalized');
  const tracePath = path.join(traceDir, 'trajectory.json');
  await fs.promises.writeFile(
    tracePath,
    `${JSON.stringify({ format: 'kbench.trace/v1', events }, null, 2)}\n`,
    'utf-8'
  );
  return {
    kind: 'normalized',
    path: tracePath,
  };
}

export async function materializeNativeTraceFile(
  instanceDir: string,
  sourcePath: string,
  relativeTargetPath: string
): Promise<TraceRef> {
  const traceDir = ensureTraceDir(instanceDir, 'native');
  const targetPath = resolveMaterializedTargetPath(traceDir, relativeTargetPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  await fs.promises.copyFile(sourcePath, targetPath);
  return {
    kind: 'native',
    path: targetPath,
  };
}
